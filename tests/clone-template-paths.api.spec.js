// @ts-check
//
// CLONE AND TEMPLATE PATHS THAT ONLY AN ODD SOURCE REACHES.
//
// routes/competitions.js makes every cloned or spawned event through one writer
// (`_materialiseEvent`), judging each challenge with `_bpTaskSkip` and each
// setting with `_bpResolve`. The ordinary paths are held by
// tests/event-clone-templates.api.spec.js and tests/clone-template-plan.api.spec.js;
// these are the refusals and skips a regression could break with nothing failing:
//
//   * a clone naming two different event types (`event_kind` and its alias
//     `kind`) is refused `kind_conflict` and makes nothing; either alone, or both
//     agreeing, is honoured;
//   * save-as-template of an event whose settings no longer validate (a tag
//     longer than any route stores, planted as an older release or a hand edit
//     could leave it) is refused 409 `template_source_invalid`; the same event
//     once valid is saved;
//   * a spawn of a template whose STORED settings no longer validate (a Program
//     template revealing answers, planted the same way) is refused 409
//     `template_invalid` and makes no event; restored, it spawns;
//   * a non-superadmin's clone and spawn leave a LOCKED challenge out, named
//     `locked`; the superadmin's carry it. The same admin's TEMPLATE SAVES keep
//     it (`_bpValidateTemplateTasks` and save-as-template exempt `locked`, as a
//     template is a plan its copies judge): their template create, a PUT sending
//     it, a rename (which re-judges the stored list) and their save-as-template,
//     beside the superadmin's save-as-template (control);
//   * a copy that lets staff compete leaves an UNSEALED challenge out, named
//     `unsealed`: a spawn whose challenge its author unsealed after the template
//     was saved (every step through the routes), and a clone and a
//     save-as-template of a compete event an older release left one in
//     (planted: no door unseals a challenge a compete event holds, asserted
//     first); the sealed ones are carried;
//   * a pinned late-entry deadline the copy cannot keep (set after End Now cut
//     the event short, so it lies before the PLANNED end the copy keeps) is
//     dropped, the copy following its own end, and named in `forced_settings`;
//     a pin the copy can keep is carried (control);
//   * Restore built-in templates names a built-in “(built-in)” when an
//     administrator's template took its name, and skips it when both names are
//     taken (the built-in's deletion is planted: a built-in cannot be deleted
//     through the API since v8.17.0);
//   * the `builtin_key` backfill in db.js keys the built-ins seeded before the
//     column existed by name AND type, once, and never an administrator's
//     template — driven by booting db.js three times on a throwaway data dir,
//     the recipe of the seeded-once lock in tests/event-clone-templates.api.spec.js.
const { test, expect } = require("./isolated-test");
const { apiLogin, PARTICIPANT_PASS, TEST_DB_PATH } = require("./helpers");
const { H, uniq, makeParticipant, makeCompetition, makeTask, assignTask, eventCopyOf, originsHeldBy } = require("./event-admin-helpers");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { BUILTIN_TEMPLATES } = require("../lib/event-template-builtins");

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const iso = (ms) => new Date(ms).toISOString();
const onTheMinute = (ms) => { const d = new Date(ms); d.setUTCSeconds(0, 0); return d.toISOString(); };
// better-sqlite3 opened inside each call: per-file isolation recreates the
// database, so a module-scope handle would read the previous file's inode.
const sql = (fn, file = TEST_DB_PATH, opts = { readonly: true }) => {
  const Database = require("better-sqlite3");
  const db = new Database(file, opts);
  try { return fn(db); } finally { db.close(); }
};
const write = (fn, file = TEST_DB_PATH) => sql(fn, file, {});
const compRow = (id) => sql(db => db.prepare("SELECT * FROM competitions WHERE id=?").get(id));
const eventsNamed = (name) => sql(db => db.prepare("SELECT COUNT(*) AS n FROM competitions WHERE name=?").get(name).n);
const templatesNamed = (name) => sql(db => db.prepare("SELECT COUNT(*) AS n FROM event_templates WHERE name=?").get(name).n);
// The questions an event holds, each named by the bank question it was copied
// from (an event holds its own copies: lib/event-copies.js).
const heldBy = (compId) => originsHeldBy(compId);
const sorted = (...ids) => [...ids].sort();

let sa, saCsrf, adm;
test.beforeAll(async () => {
  ({ api: sa, csrf: saCsrf } = await apiLogin("superadmin"));
  // A regular admin: user-backed (so they can author a SEALED challenge) and
  // not a superadmin (so a locked challenge is not theirs to carry).
  const p = await makeParticipant(sa, saCsrf, "cpadmin");
  const pr = await sa.post(`/api/admin/participants/${p.id}/role`, { headers: H(saCsrf), data: { role: "admin" } });
  expect(pr.ok(), `promote: ${pr.status()} ${await pr.text()}`).toBeTruthy();
  const s = await apiLogin(p.email, PARTICIPANT_PASS);
  adm = { ...p, api: s.api, csrf: s.csrf };
  const me = await (await adm.api.get("/api/admin/me")).json();
  expect({ role: me.role, isSuperAdmin: me.isSuperAdmin }, "PRECONDITION: a regular admin").toEqual({ role: "admin", isSuperAdmin: false });
});
test.afterAll(async () => {
  for (const a of [sa, adm && adm.api]) { if (!a) continue; try { await a.dispose(); } catch (e) { console.warn("dispose failed:", e && e.message); } }
});

async function clone(api, csrf, srcId, data) {
  const r = await api.post(`/api/admin/competitions/${srcId}/clone`, { headers: H(csrf), data });
  expect(r.status(), `clone: ${await r.text()}`).toBe(200);
  return r.json();
}
async function spawn(api, csrf, tplId, data) {
  const r = await api.post(`/api/admin/event-templates/${tplId}/spawn`, { headers: H(csrf), data });
  expect(r.status(), `spawn: ${await r.text()}`).toBe(200);
  return r.json();
}
async function makeTemplate(data, as = { api: sa, csrf: saCsrf }) {
  const r = await as.api.post("/api/admin/event-templates", { headers: H(as.csrf), data });
  expect(r.status(), `template: ${await r.text()}`).toBe(200);
  return (await r.json()).template;
}
async function saveAsTemplate(api, csrf, srcId, name) {
  const r = await api.post(`/api/admin/competitions/${srcId}/save-as-template`, { headers: H(csrf), data: { name } });
  expect(r.status(), `save-as-template: ${await r.text()}`).toBe(200);
  return r.json();
}
/** The challenge ids a template STORES (the wire withholds those its reader may not view). */
const storedTaskIds = (tplId) => JSON.parse(sql(db => db.prepare("SELECT task_ids FROM event_templates WHERE id=?").get(tplId).task_ids));

test.describe("Clone and template refusals", () => {
  test("a clone naming two different event types is refused kind_conflict and makes nothing; the alias alone, or both agreeing, is honoured", async () => {
    const src = await makeCompetition(sa, saCsrf, "kc");
    const conflict = `KC ${uniq("x")}`;
    const r = await sa.post(`/api/admin/competitions/${src.id}/clone`, { headers: H(saCsrf), data: { name: conflict, event_kind: "booth", kind: "program" } });
    expect(r.status(), await r.text()).toBe(400);
    expect((await r.json()).code).toBe("kind_conflict");
    expect(eventsNamed(conflict), "a refused clone makes nothing").toBe(0);
    // CONTROLS: the alias alone is a kind change, and agreeing values are one.
    const alias = await clone(sa, saCsrf, src.id, { name: `KC ${uniq("a")}`, kind: "booth" });
    expect(alias.competition.event_kind, "`kind` alone is honoured").toBe("booth");
    const both = await clone(sa, saCsrf, src.id, { name: `KC ${uniq("b")}`, event_kind: "program", kind: "program" });
    expect(both.competition.event_kind, "the same type sent twice is no conflict").toBe("program");
  });

  test("save-as-template refuses an event whose settings no longer validate (409 template_source_invalid) and saves it once they do", async () => {
    const src = await makeCompetition(sa, saCsrf, "tsi", { tags: ["kept"] });
    const long = `t${"x".repeat(50)}`;
    const tr = await sa.post(`/api/admin/competitions/${src.id}/tags`, { headers: H(saCsrf), data: { tag: long } });
    expect(tr.status(), "PRECONDITION: no route stores a tag over 50 characters").toBe(400);
    write(db => db.prepare("INSERT INTO competition_tags (competition_id, tag) VALUES (?,?)").run(src.id, long));
    const name = `TSI ${uniq("t")}`;
    const r = await sa.post(`/api/admin/competitions/${src.id}/save-as-template`, { headers: H(saCsrf), data: { name } });
    expect(r.status(), await r.text()).toBe(409);
    const b = await r.json();
    expect(b.code).toBe("template_source_invalid");
    expect(b.error, "it says what is wrong").toMatch(/^This event's settings cannot be saved as a template: .*at most 50 characters/);
    expect(templatesNamed(name), "a refused save writes no template").toBe(0);
    // CONTROL: the same event, once its settings validate, is saved.
    write(db => db.prepare("DELETE FROM competition_tags WHERE competition_id=? AND tag=?").run(src.id, long));
    const ok = await sa.post(`/api/admin/competitions/${src.id}/save-as-template`, { headers: H(saCsrf), data: { name } });
    expect(ok.status(), await ok.text()).toBe(200);
    expect((await ok.json()).template.settings.tags).toEqual(["kept"]);
  });

  test("spawning a template whose stored settings no longer validate is refused (409 template_invalid) and makes no event; restored, it spawns", async () => {
    const tpl = await makeTemplate({ name: `TI ${uniq("t")}`, event_kind: "program", settings: { duration_minutes: 43200 } });
    const good = sql(db => db.prepare("SELECT settings FROM event_templates WHERE id=?").get(tpl.id).settings);
    // A Program never reveals answers (the create route refuses it); a row an
    // older release or a hand edit left that way is judged at every spawn.
    write(db => db.prepare("UPDATE event_templates SET settings=? WHERE id=?").run(JSON.stringify({ duration_minutes: 43200, reveal_answers_on_end: true }), tpl.id));
    const name = `TI ev ${uniq("e")}`;
    const r = await sa.post(`/api/admin/event-templates/${tpl.id}/spawn`, { headers: H(saCsrf), data: { name } });
    expect(r.status(), await r.text()).toBe(409);
    const b = await r.json();
    expect(b.code).toBe("template_invalid");
    expect(b.error, "it says what is wrong and who can fix it").toMatch(/^This template's settings are no longer valid: This event type does not reveal answers .* Ask an administrator to edit the template\.$/);
    expect(eventsNamed(name), "a refused spawn makes no event").toBe(0);
    expect((await sa.get(`/api/admin/event-templates/${tpl.id}`)).status(), "the template itself still reads").toBe(200);
    // CONTROL: the same template, its settings valid again, spawns.
    write(db => db.prepare("UPDATE event_templates SET settings=? WHERE id=?").run(good, tpl.id));
    const ok = await spawn(sa, saCsrf, tpl.id, { name });
    expect(ok.competition.event_kind).toBe("program");
    expect(eventsNamed(name)).toBe(1);
  });
});

test.describe("Challenges a copy leaves out", () => {
  test("a non-superadmin's clone and spawn leave a LOCKED challenge out by name while the same admin's template saves keep it; the superadmin's carry it (control)", async () => {
    const src = await makeCompetition(sa, saCsrf, "lk");
    const L = await makeTask(sa, saCsrf, "lk-locked"), O = await makeTask(sa, saCsrf, "lk-open");
    await assignTask(sa, saCsrf, L.id, [src.id]);
    await assignTask(sa, saCsrf, O.id, [src.id]);
    // The source event holds its own copy of L (lib/event-copies.js): the clone
    // judges that copy, the templates the bank question. Both are locked.
    const Lc = eventCopyOf(L.id, src.id);
    expect(Lc, "PRECONDITION: the event holds its own copy").toBeTruthy();
    for (const id of [L.id, Lc]) {
      const lk = await sa.post(`/api/admin/tasks/${id}/lock`, { headers: H(saCsrf) });
      expect((await lk.json()).locked, "PRECONDITION: the toggle locked it").toBe(1);
    }
    const leftOut = (b, how, lockedId) => {
      expect(b.skipped_challenges, `${how}: the locked challenge is named`).toEqual([{ task_id: lockedId, title: L.title, reason: "locked" }]);
      expect(b.assigned_challenges, how).toBe(1);
      expect(heldBy(b.competition.id), `${how}: the copy holds the other one only`).toEqual([O.id]);
    };
    // To the regular admin it IS a locked challenge (`_bpTaskSkip` answers
    // `locked`, as their clone shows), so each template save below that keeps
    // it is the `locked` exemption at work, never a skip that did not fire.
    leftOut(await clone(adm.api, adm.csrf, src.id, { name: `LK c ${uniq("a")}` }), "an admin's clone", Lc);

    // TEMPLATE SAVES keep it: a template is a plan, and each copy made from it
    // judges its own actor. The admin's create, a PUT sending it, and a PUT that
    // re-judges the stored list (a rename alone).
    const tpl = await makeTemplate({ name: `LK ${uniq("t")}`, event_kind: "tournament", settings: { duration_minutes: 60 }, task_ids: [L.id, O.id] },
      { api: adm.api, csrf: adm.csrf });
    expect(storedTaskIds(tpl.id), "a regular admin's template create keeps the locked challenge").toEqual([L.id, O.id]);
    const put = async (data, how) => {
      const r = await adm.api.put(`/api/admin/event-templates/${tpl.id}`, { headers: H(adm.csrf), data });
      expect(r.status(), `${how}: ${await r.text()}`).toBe(200);
    };
    await put({ task_ids: [O.id, L.id] }, "a PUT sending the locked challenge");
    expect(storedTaskIds(tpl.id), "…and a PUT sending it").toEqual([O.id, L.id]);
    await put({ name: `LK ${uniq("r")}` }, "a rename");
    expect(storedTaskIds(tpl.id), "…and a rename, which re-judges the stored list").toEqual([O.id, L.id]);
    // Save-as-template keeps it as well, the admin's as the superadmin's (control).
    for (const [how, api, csrf] of [["an admin's", adm.api, adm.csrf], ["CONTROL: the superadmin's", sa, saCsrf]]) {
      const st = await saveAsTemplate(api, csrf, src.id, `LK st ${uniq("s")}`);
      expect(st.skipped_challenges, `${how} save-as-template leaves nothing out`).toEqual([]);
      expect(storedTaskIds(st.template.id), `${how} save-as-template keeps the locked challenge`).toEqual([L.id, O.id]);
    }

    // A COPY of that template judges the admin who makes it.
    leftOut(await spawn(adm.api, adm.csrf, tpl.id, { name: `LK s ${uniq("a")}` }), "an admin's spawn", L.id);
    for (const [how, b] of [
      ["the superadmin's clone", await clone(sa, saCsrf, src.id, { name: `LK c ${uniq("s")}` })],
      ["the superadmin's spawn", await spawn(sa, saCsrf, tpl.id, { name: `LK s ${uniq("s")}` })],
    ]) {
      expect(b.skipped_challenges, `CONTROL: ${how} skips nothing`).toEqual([]);
      expect(heldBy(b.competition.id), `CONTROL: ${how} carries both`).toEqual(sorted(L.id, O.id));
    }
  });

  test("a copy or template that lets staff compete leaves an UNSEALED challenge out by name, by spawn, clone and save-as-template; sealed ones are carried (control)", async () => {
    const sealed = (label) => makeTask(adm.api, adm.csrf, label, { answer_sealed: true, correct_answer: `SEALKEY_${uniq("k")}` });
    const sealedFlag = (id) => sql(db => db.prepare("SELECT answer_sealed FROM tasks WHERE id=?").get(id).answer_sealed);
    const unsealedEntry = (t) => ({ task_id: t.id, title: t.title, reason: "unsealed", message: expect.stringContaining(`“${t.title}” is not sealed`) });

    // SPAWN, every step through the routes: the template is saved with two
    // sealed challenges, then the author unseals one (no compete EVENT holds it).
    const Sa = await sealed("us-a"), Sb = await sealed("us-b");
    const tpl = await makeTemplate({ name: `US ${uniq("t")}`, event_kind: "tournament", settings: { duration_minutes: 60, staff_compete: true }, task_ids: [Sa.id, Sb.id] });
    const un = await adm.api.put(`/api/admin/tasks/${Sa.id}`, { headers: H(adm.csrf), data: { answer_sealed: false } });
    expect(un.status(), `unseal: ${await un.text()}`).toBe(200);
    expect([sealedFlag(Sa.id), sealedFlag(Sb.id)], "PRECONDITION: one unsealed, one sealed").toEqual([0, 1]);
    const sp = await spawn(sa, saCsrf, tpl.id, { name: `US s ${uniq("s")}` });
    expect(compRow(sp.competition.id).staff_compete, "PRECONDITION: staff compete in the spawned event").toBe(1);
    expect(sp.skipped_challenges).toEqual([unsealedEntry(Sa)]);
    expect(heldBy(sp.competition.id), "CONTROL: the sealed one is carried").toEqual([Sb.id]);

    // CLONE: a compete event holding an unsealed challenge cannot be built
    // through the routes (the unseal is refused while it holds it, asserted), so
    // the row an older release left is planted.
    const E = await makeCompetition(sa, saCsrf, "us-src", { staff_compete: true });
    const Sc = await sealed("us-c"), Sd = await sealed("us-d");
    await assignTask(sa, saCsrf, Sc.id, [E.id]);
    await assignTask(sa, saCsrf, Sd.id, [E.id]);
    // E holds its own copy of Sc (lib/event-copies.js): that is the question
    // no door unseals, and the one the planted row unseals.
    const Scc = eventCopyOf(Sc.id, E.id);
    const refused = await adm.api.put(`/api/admin/tasks/${Scc}`, { headers: H(adm.csrf), data: { answer_sealed: false } });
    expect(refused.status(), "PRECONDITION: no door unseals a challenge a compete event holds").toBe(409);
    expect((await refused.json()).code).toBe("answer_seal_in_compete_event");
    write(db => db.prepare("UPDATE tasks SET answer_sealed=0 WHERE id=?").run(Scc));
    const cl = await clone(sa, saCsrf, E.id, { name: `US c ${uniq("c")}` });
    expect(compRow(cl.competition.id).staff_compete, "PRECONDITION: the copy lets staff compete").toBe(1);
    expect(cl.skipped_challenges).toEqual([{ ...unsealedEntry(Sc), task_id: Scc }]);
    expect(heldBy(cl.competition.id), "CONTROL: the sealed one is carried").toEqual([Sd.id]);

    // SAVE-AS-TEMPLATE of the same source: a template that lets staff compete
    // leaves the unsealed challenge out by name (its entry carries no message)
    // and keeps the sealed one.
    const st = await saveAsTemplate(sa, saCsrf, E.id, `US st ${uniq("t")}`);
    expect(st.template.settings.staff_compete, "PRECONDITION: the template lets staff compete").toBe(true);
    expect(st.skipped_challenges).toEqual([{ task_id: Sc.id, title: Sc.title, reason: "unsealed" }]);
    expect(storedTaskIds(st.template.id), "CONTROL: the sealed one is kept").toEqual([Sd.id]);
  });
});

test.describe("A pinned late-entry deadline the copy cannot keep", () => {
  test("is dropped, the copy following its own end, and named in forced_settings; a pin it can keep is carried (control)", async () => {
    // A Booth Event planned for two hours, its late entries pinned an hour after
    // that planned end.
    const start = Date.now() - 10 * MIN;
    const plannedEnd = start + 120 * MIN;
    const src = await makeCompetition(sa, saCsrf, "pin", {
      event_kind: "booth", start_time: iso(start), duration_minutes: 120, add_qualifying: false,
      late_entry_enabled: true, late_entry_deadline_at: iso(plannedEnd + 60 * MIN),
    });
    const gap = (id) => { const c = compRow(id); return Date.parse(c.late_entry_deadline_at) - (Date.parse(c.start_time) + c.duration_minutes * MIN); };
    const keep = await clone(sa, saCsrf, src.id, { name: `Pin ${uniq("k")}`, start_time: onTheMinute(Date.now() + 3 * DAY) });
    expect(keep.forced_settings, "CONTROL: a pin the copy can keep is not named").not.toContain("late_entry_deadline_at");
    expect(gap(keep.competition.id), "CONTROL: …and is carried an hour after the copy's end").toBe(60 * MIN);

    // End Now cuts the event short; the organiser then pins late entries twenty
    // minutes from now: after the event's real end, before its PLANNED end, which
    // is the end a copy keeps.
    const end = await sa.post(`/api/admin/competitions/${src.id}/end-now`, { headers: H(saCsrf) });
    expect(end.ok(), `end-now: ${end.status()} ${await end.text()}`).toBeTruthy();
    const pin = onTheMinute(Date.now() + 20 * MIN);
    const put = await sa.put(`/api/admin/competitions/${src.id}`, { headers: H(saCsrf), data: { late_entry_deadline_at: pin } });
    expect(put.status(), `re-pin: ${await put.text()}`).toBe(200);
    const s = compRow(src.id);
    expect({ manual: s.ended_manually, pin: s.late_entry_deadline_at }, "PRECONDITION: ended by hand, pinned anew").toEqual({ manual: 1, pin });
    expect(Date.parse(pin), "PRECONDITION: the pin lies before the planned end").toBeLessThan(plannedEnd);

    const drop = await clone(sa, saCsrf, src.id, { name: `Pin ${uniq("d")}`, start_time: onTheMinute(Date.now() + 3 * DAY) });
    expect(drop.forced_settings, "the clone says it did not carry the pin").toContain("late_entry_deadline_at");
    const c = compRow(drop.competition.id);
    expect({ minutes: c.duration_minutes, late: c.late_entry_enabled, pin: c.late_entry_deadline_at },
      "the planned two hours, late entries on, following the copy's own end").toEqual({ minutes: 120, late: 1, pin: null });
    const created = JSON.parse(sql(db => db.prepare("SELECT details FROM competition_events WHERE competition_id=? AND event_type='created'").get(c.id).details));
    expect(created.forced_settings, "and its History says so").toContain("late_entry_deadline_at");
  });
});

test.describe("Built-in templates", () => {
  test("Restore built-in templates names a built-in “(built-in)” when an administrator's template took its name, and skips it when both names are taken", async () => {
    const list = async () => (await (await sa.get("/api/admin/event-templates")).json()).templates;
    const bi = (await list()).find(t => t.builtin_key === "tournament-2h");
    expect(bi && bi.name, "PRECONDITION: the built-in Competition template").toBe("Competition (several sessions)");
    // Deleted before built-ins were protected (no route deletes one now).
    write(db => db.prepare("DELETE FROM event_templates WHERE id=?").run(bi.id));
    const own = await makeTemplate({ name: "Competition (several sessions)", event_kind: "tournament", settings: { duration_minutes: 45 } });
    const r = await sa.post("/api/admin/event-templates/restore-builtins", { headers: H(saCsrf) });
    expect(r.status(), await r.text()).toBe(200);
    expect((await r.json()).restored.map(x => [x.name, x.builtin_key])).toEqual([["Competition (several sessions) (built-in)", "tournament-2h"]]);
    const after = await list();
    expect(after.filter(t => t.builtin_key === "tournament-2h").map(t => [t.name, t.is_builtin]), "the built-in is back under the other name").toEqual([["Competition (several sessions) (built-in)", true]]);
    expect(after.find(t => t.id === own.id), "the administrator's template keeps its name").toMatchObject({ name: "Competition (several sessions)", is_builtin: false, builtin_key: null });

    // Both names taken: it is skipped, never a failure, and still listed as missing.
    write(db => db.prepare("DELETE FROM event_templates WHERE builtin_key='tournament-2h'").run());
    await makeTemplate({ name: "Competition (several sessions) (built-in)", event_kind: "tournament", settings: { duration_minutes: 30 } });
    const r2 = await sa.post("/api/admin/event-templates/restore-builtins", { headers: H(saCsrf) });
    expect(r2.status(), await r2.text()).toBe(200);
    expect((await r2.json()).restored).toEqual([]);
    expect((await (await sa.get("/api/admin/event-templates/deleted")).json()).missing_builtins).toEqual(["Competition (several sessions)"]);
  });

  test("the builtin_key backfill keys the built-ins seeded before the column by name and type, once, and never an administrator's template", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tpl-key-"));
    const dbFile = path.join(dir, "hackathon.db");
    const boot = (label) => {
      const r = require("child_process").spawnSync(process.execPath, ["-e", "require('./db')"], {
        cwd: path.join(__dirname, ".."),
        env: { ...process.env, NODE_OPTIONS: "", DATA_DIR: dir, UPLOADS_DIR: `${dir}/uploads`, BASE_URL: "http://localhost", SMTP_HOST: "localhost" },
        encoding: "utf8",
      });
      expect(r.status, `${label}: ${r.stderr}`).toBe(0);
    };
    const rows = () => sql(db => db.prepare("SELECT name, event_kind, is_builtin, builtin_key FROM event_templates ORDER BY name").all(), dbFile);
    const marker = () => sql(db => db.prepare("SELECT value FROM settings WHERE key='event_templates_builtin_key_at'").get(), dbFile);
    try {
      boot("first boot");
      expect(rows().map(r => r.builtin_key).sort(), "PRECONDITION: a fresh database seeds the three built-ins with their keys")
        .toEqual(["booth-quick-spin", "program-30d", "tournament-2h"]);
      expect(marker(), "PRECONDITION: the backfill's marker is set").toBeTruthy();
      // A database from before the keys were filled: none set, no marker. An
      // administrator had renamed one built-in, changed another's type, and
      // given a template of their own the freed name.
      write(db => {
        // Such a database holds the built-ins under their FIRST definitions.
        for (const b of BUILTIN_TEMPLATES) {
          db.prepare("UPDATE event_templates SET name=?, description=?, settings=? WHERE builtin_key=?")
            .run(b.previous.name, b.previous.description, JSON.stringify(b.previous.settings), b.key);
        }
        db.prepare("UPDATE event_templates SET builtin_key=NULL").run();
        db.prepare("UPDATE event_templates SET name='Our tournament' WHERE name='Tournament (2 h)'").run();
        db.prepare("UPDATE event_templates SET event_kind='tournament' WHERE name='Learning Program (30 days)'").run();
        const at = new Date().toISOString();
        db.prepare("INSERT INTO event_templates (id, name, description, event_kind, settings, task_ids, created_at, updated_at, is_builtin) VALUES (?,?,'','tournament','{\"duration_minutes\":60}','[]',?,?,0)")
          .run(require("crypto").randomUUID(), "Tournament (2 h)", at, at);
        db.prepare("DELETE FROM settings WHERE key='event_templates_builtin_key_at'").run();
      }, dbFile);
      boot("second boot");
      expect(rows(), "only the built-in whose name AND type still match is keyed").toEqual([
        { name: "Booth quick-spin", event_kind: "booth", is_builtin: 1, builtin_key: "booth-quick-spin" },
        { name: "Learning Program (30 days)", event_kind: "tournament", is_builtin: 1, builtin_key: null },
        { name: "Our tournament", event_kind: "tournament", is_builtin: 1, builtin_key: null },
        { name: "Tournament (2 h)", event_kind: "tournament", is_builtin: 0, builtin_key: null },
      ]);
      expect(marker(), "the marker is set again").toBeTruthy();
      // ONCE: a key cleared after the backfill ran is not filled by the next boot.
      write(db => db.prepare("UPDATE event_templates SET builtin_key=NULL WHERE name='Booth quick-spin'").run(), dbFile);
      boot("third boot");
      expect(rows().find(r => r.name === "Booth quick-spin").builtin_key, "the backfill does not run twice").toBeNull();
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  // The built-ins became the kinds' RECOMMENDED SETUPS (renamed, re-described,
  // the booth one a full day). A stored built-in moves only while it still
  // equals the definition it replaced, so an administrator's edit is kept; a
  // new name another template holds leaves the row as it is; once, behind its
  // marker, written even when nothing moved.
  test("the recommended-setup rename moves only an untouched built-in, once, and never onto a name another template holds", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tpl-rename-"));
    const dbFile = path.join(dir, "hackathon.db");
    const boot = (label) => {
      const r = require("child_process").spawnSync(process.execPath, ["-e", "require('./db')"], {
        cwd: path.join(__dirname, ".."),
        env: { ...process.env, NODE_OPTIONS: "", DATA_DIR: dir, UPLOADS_DIR: `${dir}/uploads`, BASE_URL: "http://localhost", SMTP_HOST: "localhost" },
        encoding: "utf8",
      });
      expect(r.status, `${label}: ${r.stderr}`).toBe(0);
      return r;
    };
    const MARKER = "event_templates_renamed_at";
    const byKey = () => Object.fromEntries(sql(db => db.prepare("SELECT builtin_key, name, description, settings FROM event_templates WHERE is_builtin=1").all(), dbFile)
      .map(r => [r.builtin_key, { name: r.name, description: r.description, settings: JSON.parse(r.settings) }]));
    const marker = () => sql(db => db.prepare("SELECT value FROM settings WHERE key=?").get(MARKER), dbFile);
    const def = (key) => BUILTIN_TEMPLATES.find(b => b.key === key);
    const current = (b) => ({ name: b.name, description: b.description, settings: { ...b.settings } });
    const previous = (b) => ({ name: b.previous.name, description: b.previous.description, settings: { ...b.previous.settings } });
    try {
      boot("first boot");
      expect(byKey(), "PRECONDITION: a fresh database seeds the current definitions").toEqual(Object.fromEntries(BUILTIN_TEMPLATES.map(b => [b.key, current(b)])));
      expect(byKey()["booth-quick-spin"].settings.duration_minutes, "PRECONDITION: the booth setup runs a full day").toBe(480);
      expect(marker(), "a fresh database writes the marker though nothing moved").toBeTruthy();

      // A database from before the rename: every built-in under its first
      // definition, no marker. The Competition one an administrator re-worded;
      // the Booth one's new name another template took (in other letter case).
      // The Program one's rename changes only a letter's case, which its own
      // row must not count as a clash.
      write(db => {
        for (const b of BUILTIN_TEMPLATES) {
          db.prepare("UPDATE event_templates SET name=?, description=?, settings=? WHERE builtin_key=?")
            .run(b.previous.name, b.previous.description, JSON.stringify(b.previous.settings), b.key);
        }
        db.prepare("UPDATE event_templates SET description='Our own words' WHERE builtin_key='tournament-2h'").run();
        const at = new Date().toISOString();
        db.prepare("INSERT INTO event_templates (id, name, description, event_kind, settings, task_ids, created_at, updated_at, is_builtin) VALUES (?,?,'','booth','{\"duration_minutes\":600}','[]',?,?,0)")
          .run(require("crypto").randomUUID(), def("booth-quick-spin").name.toUpperCase(), at, at);
        db.prepare("DELETE FROM settings WHERE key=?").run(MARKER);
      }, dbFile);
      expect(def("program-30d").name.toLowerCase(), "PRECONDITION: the Program rename is a change of case").toBe(def("program-30d").previous.name.toLowerCase());
      const second = boot("second boot");
      const after = byKey();
      expect(after["program-30d"], "the untouched built-in moves to its recommended setup").toEqual(current(def("program-30d")));
      expect(after["tournament-2h"], "the edited one is left exactly as the administrator left it")
        .toEqual({ ...previous(def("tournament-2h")), description: "Our own words" });
      expect(after["booth-quick-spin"], "the one whose new name is taken keeps its first definition").toEqual(previous(def("booth-quick-spin")));
      expect(second.stderr, "and the skip is logged").toContain(`kept its name: another template is already called "${def("booth-quick-spin").name}"`);
      expect(marker(), "the marker is written").toBeTruthy();

      // ONCE: a row put back to its first definition after the rename ran is
      // not moved by the next boot.
      write(db => db.prepare("UPDATE event_templates SET name=?, description=?, settings=? WHERE builtin_key='program-30d'")
        .run(def("program-30d").previous.name, def("program-30d").previous.description, JSON.stringify(def("program-30d").previous.settings)), dbFile);
      boot("third boot");
      expect(byKey()["program-30d"], "the rename does not run twice").toEqual(previous(def("program-30d")));
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
