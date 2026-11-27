// @ts-check
// ─────────────────────────────────────────────────────────────────────────────
// The orphaned-image sweep (lib/image-sweep.js), which rides the daily retention
// pass (lib/event-retention.js; driven here by POST /api/test/purge-events).
//
//   1. THE MANIFEST (lib/image-refs.js): every text or blob column of every table
//      in a booted database has exactly one decision (scanned, an id holder, or
//      exempt with a known reason), and no entry names a column that is gone.
//      Planted controls prove the check fails both ways.
//   2. Every holder the platform has is SCANNED: an image named only there is
//      kept, an unnamed one of the same age beside it is deleted. The holders are
//      this spec's own list, held to the manifest both ways, so a holder moved to
//      `exempt` fails here, and a new scanned column needs a planter here.
//   3. A challenge's image edited out of the text is kept while a version
//      snapshot names it, and deleted once nothing does (the challenge deleted).
//   4. The grace period, the per-run cap (oldest first), the pass's summary and
//      its `events_purged` record.
//   5. A replaced avatar is reclaimed at once only when nothing else names it:
//      a frozen team board that copied it keeps it (lib/sanitise.js
//      deleteAvatarImage asks the same manifest).
//   6. Deleting a person reclaims their avatars WHATEVER a frozen board holds
//      (erasure wins for the avatar): the boards' copies are struck to the
//      preset default, the images deleted, while
//      another person's replaced avatar a board names is kept.
//   7. The image sweep holds while the instance is out of service (maintenance
//      here; the gate is server.js `_instanceInService`): an unnamed old image
//      is kept, the event purge still runs, and both doors that run the pass
//      (the test hook, the superadmin's manual purge) say `images_held`; lifted,
//      the image goes. Each pass reports its reference collection's time.
//   8. A reference is read whatever its case (`/API/Images/<id>`) and whatever
//      its id holds (`_`, as an older certificate's base64url id may): each
//      picture named only that way is kept, an unnamed one beside them swept.
//   9. GET /api/images/:id is cached privately for a day with the id as a strong
//      ETag: a matching If-None-Match is a 304, a deleted row a 404.
// ─────────────────────────────────────────────────────────────────────────────
const { test, expect } = require("./isolated-test");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const { apiLogin, pngDataUri, PARTICIPANT_PASS, TEST_DB_PATH, TEST_DATA_DIR, BASE, findLogLine } = require("./helpers");
const { H, uniq, makeParticipant } = require("./event-admin-helpers");
const { imageRefDecisions, IMAGE_REF_EXEMPT_REASONS } = require("../lib/image-refs");

test.use({ baseURL: BASE });

const DAY = 86_400_000;
const PIXEL = Buffer.from("89504e470d0a1a0a", "hex");

function withDb(fn, { readonly = false } = {}) {
  const d = new Database(TEST_DB_PATH, readonly ? { readonly: true } : {});
  d.pragma("busy_timeout = 5000");
  try { return fn(d); } finally { d.close(); }
}
const dbGet = (sql, ...a) => withDb(d => d.prepare(sql).get(...a), { readonly: true });
const imageExists = (id) => !!dbGet("SELECT 1 AS x FROM images WHERE id=?", id);
/** Plant an image row of the given age (days); returns its id. */
function plantImage(ageDays, id = crypto.randomUUID()) {
  withDb(d => d.prepare("INSERT INTO images (id, data, mime_type, created_at) VALUES (?,?,?,?)")
    .run(id, PIXEL, "image/png", new Date(Date.now() - ageDays * DAY).toISOString()));
  return id;
}
const ref = (id) => `/api/images/${id}`;

// ── the manifest against a schema ──────────────────────────────────────────
/** SQLite's affinity rules: TEXT for CHAR/CLOB/TEXT, BLOB for BLOB or no type. */
const textOrBlob = (type) => /CHAR|CLOB|TEXT|BLOB/i.test(type) || String(type).trim() === "";
function schemaColumns(d) {
  const out = [];
  for (const { name } of d.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()) {
    for (const c of d.prepare("SELECT name, type FROM pragma_table_info(?)").all(name)) {
      if (textOrBlob(c.type)) out.push(`${name}.${c.name}`);
    }
  }
  return out;
}
/** What the manifest gets wrong about a schema: undecided, decided twice, stale, unknown reason. */
function manifestDrift(columns, decisions) {
  const seen = new Map();
  const twice = [], badReason = [];
  for (const dd of decisions) {
    const k = `${dd.table}.${dd.column}`;
    if (seen.has(k)) twice.push(k);
    seen.set(k, dd);
    if (dd.kind === "exempt" && !Object.prototype.hasOwnProperty.call(IMAGE_REF_EXEMPT_REASONS, dd.reason)) badReason.push(`${k}:${dd.reason}`);
  }
  const live = new Set(columns);
  return {
    undecided: columns.filter(k => !seen.has(k)),
    twice,
    stale: [...seen.keys()].filter(k => !live.has(k)),
    badReason,
  };
}

test.describe("orphaned image sweep — the manifest", () => {
  test("every text or blob column of the booted database has exactly one decision, and no entry is stale (planted controls fail both ways)", () => {
    const columns = withDb(schemaColumns, { readonly: true });
    const decisions = imageRefDecisions();
    // Anti-vacuity: a real schema, a real manifest.
    expect(columns.length, "the schema walk saw the platform's columns").toBeGreaterThan(350);
    expect(columns, "the walk includes the image store's blob").toContain("images.data");
    expect(decisions.filter(dd => dd.kind === "scan").length, "the manifest scans the platform's holders").toBeGreaterThanOrEqual(10);
    expect(decisions.filter(dd => dd.kind === "ids").map(dd => `${dd.table}.${dd.column}`)).toEqual(["achievement_badges.image_id"]);
    expect(manifestDrift(columns, decisions)).toEqual({ undecided: [], twice: [], stale: [], badReason: [] });
    // Every reason named is used, so a stale one goes too.
    const used = new Set(decisions.filter(dd => dd.kind === "exempt").map(dd => dd.reason));
    expect(Object.keys(IMAGE_REF_EXEMPT_REASONS).filter(r => !used.has(r)), "no unused exemption reason").toEqual([]);

    // CONTROLS: a planted column with no decision, a stale entry, a second
    // decision and an unknown reason are each caught.
    const planted = manifestDrift([...columns, "tasks.new_rich_field"],
      [...decisions, { table: "users", column: "retired_col", kind: "exempt", reason: "plain" },
        { table: "users", column: "avatar", kind: "exempt", reason: "plain" },
        { table: "tasks", column: "title", kind: "exempt", reason: "no_such_reason" }]);
    expect(planted.undecided).toEqual(["tasks.new_rich_field"]);
    expect(planted.stale).toEqual(["users.retired_col"]);
    expect(planted.twice).toEqual(expect.arrayContaining(["users.avatar", "tasks.title"]));
    expect(planted.badReason).toEqual(["tasks.title:no_such_reason"]);
  });
});

test.describe("orphaned image sweep — behaviour", () => {
  let sa, saCsrf;
  test.beforeAll(async () => { ({ api: sa, csrf: saCsrf } = await apiLogin("superadmin")); });
  test.afterAll(async () => { await sa?.dispose(); });

  async function purge(data = {}) {
    const r = await sa.post("/api/test/purge-events", { headers: H(saCsrf), data });
    expect(r.ok(), `purge: ${r.status()} ${await r.text()}`).toBeTruthy();
    return r.json();
  }
  async function makeComp(label) {
    const r = await sa.post("/api/admin/competitions", { headers: H(saCsrf), data: {
      name: `Img ${uniq(label)}`, start_time: new Date(Date.now() + DAY).toISOString(), duration_minutes: 60 } });
    expect(r.status(), await r.text()).toBe(200);
    return (await r.json()).competition.id;
  }
  async function makeTask(label, description = "<p>plain</p>") {
    const r = await sa.post("/api/admin/tasks", { headers: H(saCsrf), data: {
      title: `Img ${uniq(label)}`, description, difficulty: "easy", answer_type: "text", correct_answer: "k" } });
    expect(r.status(), await r.text()).toBe(200);
    return (await r.json()).id;
  }

  // THE HOLDERS: this spec's own statement of where a picture can be named,
  // each with a planter that names `id` there and nowhere else.
  const HOLDERS = {
    "tasks.description": async (id) => { const t = await makeTask("desc"); withDb(d => d.prepare("UPDATE tasks SET description=? WHERE id=?").run(`<p><img src="${ref(id)}"></p>`, t)); },
    "tasks.explanation": async (id) => { const t = await makeTask("expl"); withDb(d => d.prepare("UPDATE tasks SET explanation=? WHERE id=?").run(`<p><img src="${ref(id)}"></p>`, t)); },
    "tasks.hint": async (id) => { const t = await makeTask("hint"); withDb(d => d.prepare("UPDATE tasks SET hint=? WHERE id=?").run(`<p><img src="${ref(id)}"></p>`, t)); },
    "task_versions.snapshot": async (id) => {
      const t = await makeTask("snap");
      withDb(d => d.prepare("UPDATE task_versions SET snapshot=? WHERE task_id=?").run(JSON.stringify({ description: `<img src="${ref(id)}">` }), t));
    },
    "users.avatar": async (id) => { const p = await makeParticipant(sa, saCsrf, "imgav"); withDb(d => d.prepare("UPDATE users SET avatar=? WHERE id=?").run(ref(id), p.id)); },
    "group_leaderboard_snapshots.board": async (id) => {
      const c = await makeComp("board");
      withDb(d => d.prepare("INSERT INTO group_leaderboard_snapshots (competition_id, slot_key, board, created_at) VALUES (?,?,?,?)")
        .run(c, "__global__", JSON.stringify([{ type: "individual", userId: "u", nickname: "n", avatar: ref(id) }]), new Date().toISOString()));
    },
    "competitions.certificate_config": async (id) => {
      const c = await makeComp("cert");
      withDb(d => d.prepare("UPDATE competitions SET certificate_config=? WHERE id=?").run(JSON.stringify({ text: { note: ref(id) } }), c));
    },
    "event_templates.description": async (id) => {
      withDb(d => d.prepare("INSERT INTO event_templates (id, name, description, event_kind, created_at, updated_at) VALUES (?,?,?,?,?,?)")
        .run(crypto.randomUUID(), `Img ${uniq("tpld")}`, `<img src="${ref(id)}">`, "tournament", new Date().toISOString(), new Date().toISOString()));
    },
    "event_templates.settings": async (id) => {
      withDb(d => d.prepare("INSERT INTO event_templates (id, name, settings, event_kind, created_at, updated_at) VALUES (?,?,?,?,?,?)")
        .run(crypto.randomUUID(), `Img ${uniq("tpls")}`, JSON.stringify({ description: ref(id) }), "tournament", new Date().toISOString(), new Date().toISOString()));
    },
    "settings.value": async (id) => {
      withDb(d => d.prepare("INSERT INTO settings (key, value) VALUES (?,?)").run(`image_sweep_probe_${uniq("k")}`, JSON.stringify({ logo: ref(id) })));
    },
    "achievement_badges.image_id": async (id) => {
      const c = await makeComp("badge");
      const p = await makeParticipant(sa, saCsrf, "imgbadge");
      withDb(d => d.prepare("INSERT INTO achievement_badges (token, user_id, competition_id, rank, image_id, nickname_snapshot, created_at) VALUES (?,?,?,?,?,?,?)")
        .run(crypto.randomBytes(16).toString("hex"), p.id, c, 1, id, "n", new Date().toISOString()));
    },
  };

  test("an image named only by any one holder is kept; an unnamed one of the same age is deleted, and a stored badge's PNG is still served", async () => {
    test.setTimeout(120_000);
    // The list is the manifest's scanned and id columns, both ways.
    const manifestHolders = imageRefDecisions().filter(dd => dd.kind !== "exempt").map(dd => `${dd.table}.${dd.column}`).sort();
    expect(Object.keys(HOLDERS).sort(), "every holder the sweep reads is planted here, and every planted holder is read").toEqual(manifestHolders);

    await purge(); // settle anything older first, so the counts below are this test's
    const held = {};
    for (const [holder, plant] of Object.entries(HOLDERS)) {
      const id = plantImage(30);
      await plant(id);
      held[holder] = id;
    }
    const orphans = [plantImage(30), plantImage(9)];
    const res = await purge();
    expect(res.images_purged, "exactly the two unnamed images went").toBe(2);
    expect(res.images_capped).toBe(false);
    for (const id of orphans) expect(imageExists(id), "an unnamed image past the grace period is deleted").toBe(false);
    const lost = Object.entries(held).filter(([, id]) => !imageExists(id)).map(([h]) => h);
    expect(lost, "no image a holder names is deleted").toEqual([]);
    // The stored share PNG is still what its certificate serves.
    const img = await sa.get(ref(held["achievement_badges.image_id"]));
    expect(img.status()).toBe(200);
    // A second pass finds nothing more.
    expect((await purge()).images_purged).toBe(0);
  });

  test("a challenge image edited out of the text is kept while a version names it, and deleted once nothing does", async () => {
    const t = await makeTask("edited", `<p>see <img src="${pngDataUri(8, uniq("edited"))}"></p>`);
    const desc = dbGet("SELECT description FROM tasks WHERE id=?", t).description;
    const m = desc.match(/\/api\/images\/([0-9a-f-]+)/);
    expect(m, "PRECONDITION: the pasted image was stored and named").toBeTruthy();
    const id = m[1];
    const put = await sa.put(`/api/admin/tasks/${t}`, { headers: H(saCsrf), data: { description: "<p>no picture now</p>" } });
    expect(put.status(), await put.text()).toBe(200);
    expect(dbGet("SELECT description FROM tasks WHERE id=?", t).description, "PRECONDITION: the text no longer names it").not.toContain(id);
    expect(dbGet("SELECT COUNT(*) AS c FROM task_versions WHERE task_id=? AND snapshot LIKE ?", t, `%${id}%`).c,
      "PRECONDITION: a version snapshot still names it").toBeGreaterThan(0);
    withDb(d => d.prepare("UPDATE images SET created_at=? WHERE id=?").run(new Date(Date.now() - 30 * DAY).toISOString(), id));

    await purge();
    expect(imageExists(id), "kept: restoring that version would show it").toBe(true);

    const del = await sa.delete(`/api/admin/tasks/${t}`, { headers: H(saCsrf) });
    expect(del.status(), await del.text()).toBe(200);
    expect(dbGet("SELECT COUNT(*) AS c FROM task_versions WHERE task_id=?", t).c, "PRECONDITION: the versions went with it").toBe(0);
    const res = await purge();
    expect(imageExists(id), "deleted once nothing names it").toBe(false);
    expect(res.images_purged).toBe(1);
  });

  test("an avatar in use is kept, and an unnamed image inside the grace period is kept until the grace is shortened", async () => {
    const p = await makeParticipant(sa, saCsrf, "avkeep");
    const s = await apiLogin(p.email, PARTICIPANT_PASS);
    try {
      const r = await s.api.put("/api/me", { headers: H(s.csrf), data: { avatar: pngDataUri(16, uniq("avkeep")) } });
      expect(r.status(), await r.text()).toBe(200);
    } finally { await s.api.dispose(); }
    const avatar = dbGet("SELECT avatar FROM users WHERE id=?", p.id).avatar;
    expect(avatar, "PRECONDITION: an uploaded avatar").toMatch(/^\/api\/images\//);
    const avatarId = avatar.slice("/api/images/".length);
    withDb(d => d.prepare("UPDATE images SET created_at=? WHERE id=?").run(new Date(Date.now() - 30 * DAY).toISOString(), avatarId));
    const young = plantImage(6);   // inside the 7-day grace
    const old = plantImage(8);     // CONTROL: past it

    const res = await purge();
    expect(imageExists(young), "an unnamed image six days old is kept").toBe(true);
    expect(imageExists(old), "CONTROL: an unnamed image eight days old is deleted").toBe(false);
    expect(imageExists(avatarId), "the avatar in use is kept").toBe(true);
    expect(res.images_purged).toBe(1);
    expect((await sa.get(avatar)).status(), "and still served").toBe(200);

    // A shorter grace (the test hook) takes the young one; the avatar stays.
    const res2 = await purge({ imageGraceMs: 0 });
    expect(imageExists(young)).toBe(false);
    expect(imageExists(avatarId)).toBe(true);
    expect(res2.images_purged).toBe(1);
  });

  test("a pass deletes at most its cap, oldest first, says more remain, and records what it deleted", async () => {
    await purge({ imageGraceMs: 0 }); // nothing unnamed left from earlier tests
    const newest = plantImage(10), oldest = plantImage(40), middle = plantImage(20);
    const p1 = await purge({ imageLimit: 1 });
    expect(p1).toMatchObject({ images_purged: 1, images_capped: true, total: 0 });
    expect([oldest, middle, newest].map(imageExists), "the oldest went first").toEqual([false, true, true]);
    const p2 = await purge({ imageLimit: 1 });
    expect(p2).toMatchObject({ images_purged: 1, images_capped: true });
    expect([middle, newest].map(imageExists)).toEqual([false, true]);
    const p3 = await purge({ imageLimit: 1 });
    expect(p3).toMatchObject({ images_purged: 1, images_capped: false });
    const p4 = await purge({ imageLimit: 1 });
    expect(p4).toMatchObject({ images_purged: 0, images_capped: false });
    // Each pass that deleted images is recorded with the count AND the ids it
    // deleted (exactly those: never one the pass kept); the empty one is not.
    const recs = withDb(d => d.prepare("SELECT details FROM orphan_events WHERE event_type='events_purged' ORDER BY rowid").all(), { readonly: true })
      .map(r => JSON.parse(r.details)).filter(dd => "images_purged" in dd);
    expect(recs.slice(-3).map(dd => dd.images_purged)).toEqual([1, 1, 1]);
    expect(recs.slice(-3).map(dd => dd.images_purged_ids), "each record names the one picture its pass deleted").toEqual([[oldest], [middle], [newest]]);
    // …and the app.jsonl line carries the same list.
    const line = await findLogLine(path.join(TEST_DATA_DIR, "logs"),
      (j) => j.event_type === "events_purged" && Array.isArray(j.details?.images_purged_ids) && j.details.images_purged_ids.includes(middle),
      { what: "the events_purged mirror line naming the middle picture" });
    expect(line.details.images_purged_ids, "the mirror line lists exactly the deleted id").toEqual([middle]);
    const last = withDb(d => d.prepare("SELECT details FROM orphan_events WHERE event_type='events_purged' ORDER BY rowid DESC LIMIT 1").get(), { readonly: true });
    expect(JSON.parse(last.details).images_purged, "the pass that deleted none wrote no record").toBe(1);
  });

  test("a replaced avatar is reclaimed at once only when nothing else names it: a frozen team board keeps it", async () => {
    const p = await makeParticipant(sa, saCsrf, "avboard");
    const s = await apiLogin(p.email, PARTICIPANT_PASS);
    try {
      const set = async (label) => {
        const r = await s.api.put("/api/me", { headers: H(s.csrf), data: { avatar: pngDataUri(16, uniq(label)) } });
        expect(r.status(), await r.text()).toBe(200);
        return dbGet("SELECT avatar FROM users WHERE id=?", p.id).avatar.slice("/api/images/".length);
      };
      const a = await set("a");
      // A team board frozen while A was the avatar.
      const c = await makeComp("avboard");
      withDb(d => d.prepare("INSERT INTO group_leaderboard_snapshots (competition_id, slot_key, board, created_at) VALUES (?,?,?,?)")
        .run(c, "__global__", JSON.stringify([{ type: "individual", userId: p.id, nickname: p.nickname, avatar: ref(a) }]), new Date().toISOString()));
      const b = await set("b");
      expect(imageExists(a), "the frozen board still shows A").toBe(true);
      expect((await sa.get(ref(a))).status()).toBe(200);
      // CONTROL: B, named nowhere else, goes as soon as it is replaced.
      await set("c");
      expect(imageExists(b), "CONTROL: an avatar nothing else names is reclaimed at once").toBe(false);
    } finally { await s.api.dispose(); }
  });

  /** A frozen team board (global slot) of an event of its own, holding these solo rows. */
  async function freezeBoard(label, rows) {
    const c = await makeComp(label);
    withDb(d => d.prepare("INSERT INTO group_leaderboard_snapshots (competition_id, slot_key, board, created_at) VALUES (?,?,?,?)")
      .run(c, "__global__", JSON.stringify(rows), new Date().toISOString()));
    return c;
  }
  const boardOf = (c) => JSON.parse(dbGet("SELECT board FROM group_leaderboard_snapshots WHERE competition_id=?", c).board);

  test("deleting a person reclaims their avatars whatever a frozen board holds, and strikes the boards' copies; another person's replaced avatar a board names is kept", async () => {
    const setAvatar = async (who, label) => {
      const s = await apiLogin(who.email, PARTICIPANT_PASS);
      try {
        const r = await s.api.put("/api/me", { headers: H(s.csrf), data: { avatar: pngDataUri(16, uniq(label)) } });
        expect(r.status(), await r.text()).toBe(200);
      } finally { await s.api.dispose(); }
      return dbGet("SELECT avatar FROM users WHERE id=?", who.id).avatar.slice("/api/images/".length);
    };
    const victim = await makeParticipant(sa, saCsrf, "erasev");
    const other = await makeParticipant(sa, saCsrf, "eraseo");
    const vOld = await setAvatar(victim, "vold");
    const oOld = await setAvatar(other, "oold");
    // One board frozen while both wore their first avatars, a second while the
    // victim wore the current one.
    const c1 = await freezeBoard("erase1", [
      { type: "group", groupId: "g", name: "Team" },
      { type: "individual", userId: victim.id, nickname: victim.nickname, avatar: ref(vOld) },
      { type: "individual", userId: other.id, nickname: other.nickname, avatar: ref(oOld) },
    ]);
    const vNow = await setAvatar(victim, "vnow");
    const oNow = await setAvatar(other, "onow");
    const c2 = await freezeBoard("erase2", [{ type: "individual", userId: victim.id, nickname: victim.nickname, avatar: ref(vNow) }]);
    expect([vOld, vNow, oOld, oNow].map(imageExists), "PRECONDITION: the boards keep both first avatars; every image is stored").toEqual([true, true, true, true]);

    const del = await sa.delete(`/api/admin/participants/${victim.id}`, { headers: H(saCsrf) });
    expect(del.status(), await del.text()).toBe(200);

    expect(imageExists(vNow), "the deleted person's current avatar is gone, though a frozen board named it").toBe(false);
    expect(imageExists(vOld), "and the older one only a frozen board kept").toBe(false);
    expect((await sa.get(ref(vOld))).status(), "and is no longer served").toBe(404);
    const b1 = boardOf(c1), b2 = boardOf(c2);
    // Struck to the preset default, as the API's board row carries an avatar as
    // text (swagger GroupBoardEntry); the row keeps its nickname (an open item).
    expect(b1.find(r => r.userId === victim.id), "the board keeps the row, its avatar struck to the default").toMatchObject({ nickname: victim.nickname, avatar: "default1" });
    expect(b2[0].avatar).toBe("default1");
    expect(JSON.stringify([b1, b2]), "no board names either picture").not.toMatch(new RegExp(`${vOld}|${vNow}`));
    // CONTROL: the other person's replaced avatar, named by the same board, is
    // kept with its row untouched, and their current one is untouched.
    expect(b1.find(r => r.userId === other.id)).toMatchObject({ avatar: ref(oOld) });
    expect(imageExists(oOld), "CONTROL: a replaced avatar a frozen board names is kept").toBe(true);
    expect(imageExists(oNow)).toBe(true);
    // The reclaim is recorded as the deletion's, not a replacement.
    const vias = withDb(d => d.prepare("SELECT scope_id, details FROM orphan_events WHERE scope='image' AND event_type='purged' AND scope_id IN (?,?)").all(vOld, vNow), { readonly: true })
      .map(r => [r.scope_id, JSON.parse(r.details).via]).sort();
    expect(vias).toEqual([[vNow, "account_deleted"], [vOld, "account_deleted"]].sort());
  });

  test("the image sweep holds while maintenance mode is on (the event purge still runs, both doors say so) and sweeps once it is lifted; each pass reports its reference collection", async () => {
    await purge({ imageGraceMs: 0 }); // nothing unnamed left from earlier tests
    const orphan = plantImage(30);
    // CONTROL: one a holder names, so the collection has a row to read.
    const named = plantImage(30);
    await HOLDERS["settings.value"](named);
    // An audit row past the 730-day window: the event purge, which is not held.
    const oldRow = crypto.randomUUID();
    withDb(d => d.prepare("INSERT INTO orphan_events (id, scope, scope_id, event_type, changed_by, changed_at, competition_id, timeslot_id, details) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(oldRow, "retention", "probe", "image_hold_probe", "system", new Date(Date.now() - 800 * DAY).toISOString(), null, null, "{}"));
    const token = `imghold-${Date.now()}`;
    const file = path.join(TEST_DATA_DIR, ".maintenance");
    const bypass = { ...H(saCsrf), "X-Maintenance-Bypass": token };
    fs.writeFileSync(file, token);
    try {
      const r = await sa.post("/api/test/purge-events", { headers: bypass, data: {} });
      expect(r.ok(), `purge: ${r.status()} ${await r.text()}`).toBeTruthy();
      const held = await r.json();
      expect(held, "held: no image deleted, and it says so").toMatchObject({ images_held: true, images_purged: 0 });
      expect(imageExists(orphan), "an unnamed old image is kept while maintenance is on").toBe(true);
      expect(dbGet("SELECT 1 AS x FROM orphan_events WHERE id=?", oldRow), "CONTROL: the event purge still ran").toBeUndefined();
      const m = await sa.post("/api/admin/retention/purge", { headers: bypass, data: {} });
      expect(m.status(), await m.text()).toBe(200);
      expect(await m.json(), "the superadmin's manual purge holds the same way").toMatchObject({ images_held: true, images_purged: 0 });
      expect(imageExists(orphan)).toBe(true);
    } finally {
      fs.rmSync(file, { force: true });
    }
    // Lifted, with the slow-collection warning threshold below any duration, so
    // the warning must be written.
    const ran = await purge({ imageRefsWarnMs: -1 });
    expect(ran, "lifted, the sweep runs").toMatchObject({ images_held: false, images_purged: 1 });
    expect(imageExists(orphan), "and the unnamed image goes").toBe(false);
    expect(imageExists(named), "CONTROL: the named one stays").toBe(true);
    // The reference collection is measured: it read the holders (the earlier
    // control's holder at least) and timed it.
    expect(ran.images_refs_rows, "the collection's rows are reported").toBeGreaterThan(0);
    expect(Number.isInteger(ran.images_refs_ms) && ran.images_refs_ms >= 0, `the collection's time is reported: ${ran.images_refs_ms}`).toBe(true);
    const warn = await findLogLine(path.join(TEST_DATA_DIR, "logs"),
      (j) => j.level === "warn" && /image sweep: collecting the image references/.test(String(j.msg || j.message || "")) && j.images_refs_rows === ran.images_refs_rows,
      { what: "the slow-collection warning" });
    expect(warn.threshold_ms, "the warning names the threshold it crossed").toBe(-1);
    const m2 = await sa.post("/api/admin/retention/purge", { headers: H(saCsrf), data: {} });
    expect(await m2.json(), "CONTROL: the manual purge, lifted, does not hold").toMatchObject({ images_held: false });
  });
  test("a picture named only by an upper-case link, or by an id holding `_`, is kept; an unnamed one beside them is swept", async () => {
    await purge({ imageGraceMs: 0 }); // nothing unnamed left from earlier tests
    const upper = plantImage(30);
    // An older certificate's share image had a base64url id, which may hold `_`.
    const underscored = plantImage(30, `Ab_${crypto.randomBytes(12).toString("base64url").replace(/-/g, "x")}_z`);
    const orphan = plantImage(30);
    const t = await makeTask("upper");
    // A link typed by hand keeps its case (the anchor sanitiser keeps any http(s)
    // href); Express serves it whatever the case of the path.
    withDb(d => d.prepare("UPDATE tasks SET description=? WHERE id=?")
      .run(`<p><a href="https://host.example/API/Images/${upper}">see</a> <img src="/api/images/${underscored}"></p>`, t));
    expect((await sa.get(`/API/Images/${upper}`)).status(), "PRECONDITION: the upper-case link is served").toBe(200);
    const res = await purge();
    expect(imageExists(upper), "kept: the challenge's upper-case link names it").toBe(true);
    expect(imageExists(underscored), "kept: an id holding `_` is read whole").toBe(true);
    expect(imageExists(orphan), "CONTROL: an unnamed picture of the same age is swept").toBe(false);
    expect(res.images_purged).toBe(1);
  });

  test("a stored picture is cached privately for a day under its id as a strong ETag: a matching If-None-Match is a 304, and once the row is gone a 404", async () => {
    const id = plantImage(1);
    const r = await sa.get(ref(id));
    expect(r.status()).toBe(200);
    expect(r.headers()["cache-control"], "a browser keeps it a day; no shared cache may keep it").toBe("private, max-age=86400");
    expect(r.headers()["etag"], "a strong ETag: the image id").toBe(`"${id}"`);
    expect((await r.body()).equals(PIXEL), "the bytes").toBe(true);
    const again = await sa.get(ref(id), { headers: { "If-None-Match": `"${id}"` } });
    expect(again.status(), "a browser past its day revalidates: 304, no body").toBe(304);
    expect((await again.body()).length).toBe(0);
    // CONTROL: another picture's tag is no match.
    const other = await sa.get(ref(id), { headers: { "If-None-Match": `"${plantImage(1)}"` } });
    expect(other.status(), "CONTROL: a different tag gets the picture").toBe(200);
    withDb(d => d.prepare("DELETE FROM images WHERE id=?").run(id));
    const gone = await sa.get(ref(id), { headers: { "If-None-Match": `"${id}"` } });
    expect(gone.status(), "once the row is gone, the revalidation is a 404").toBe(404);
  });
});
