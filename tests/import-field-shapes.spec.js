// @ts-check
//
// v8.3.20 (external audit) — THE IMPORT POLICES FIELD SHAPES, NOT ONLY ROW
// SHAPES; AND IT STOPS BLOCKING THE EVENT LOOP FOR SECONDS AT A TIME.
//
// v7.21.1 (A10) established the rule this file extends: a wrong-TYPED element
// means the FILE is malformed, so the batch is REFUSED with a message naming the
// row — as opposed to a well-typed but semantically unimportable row, which is
// SKIPPED. That release applied it to the ROW and left every FIELD unchecked, so
// a wrong-typed field reached the same binds:
//
//   • `title: {a:1}` / `title: true`  → the opaque 500 the rule exists to
//     replace, naming no row.
//   • `title: ["x"]`                  → WORSE THAN A CRASH. better-sqlite3
//     spreads an array as POSITIONAL bindings, so a one-element array was
//     ACCEPTED, matched a conflict against a title the file never named, and
//     STORED `x`. A silently wrong title beats a refusal in exactly the wrong
//     direction.
//   • `active: "yes"`                 → stored as TEXT in an INTEGER column, and
//     that is a split-brain rather than a cosmetic wrong type: SQL predicates
//     (`WHERE t.active=1`, the all-solved denominator) read it as INACTIVE while
//     JS predicates (`if (!task.active)`) read it as ACTIVE. Nothing on any
//     screen can show it.
//   • `status: "banana"`              → stored verbatim, where the create path
//     normalises to published-or-draft. `tasks.status` carries no CHECK, so the
//     two writers disagreed about what the column may hold.
//
// AND THE ADMIN-TIER TWIN. `active` is not superadmin-gated: it is bound raw
// into `active=COALESCE(?,active)` by `PUT /api/admin/tasks/:id`, which is in
// neither the H4 typeof loop nor TASK_FIELD_CAPS.
//
// THE CLAMP HALF. v8.3.17 F4 routed four of the six capped string fields through
// the clamp and left `correct_answer` (65536) and `author_linkedin` (500)
// carrying a TASK_FIELD_CAPS entry that nothing enforced — so the import could
// still store the row an admin can open and cannot save, which is the defect F4
// was filed for. `author_name` was clamped with a bare `.slice()`, so its
// truncation was not counted in `fields_truncated`: a silent clamp, which
// lib/task-fields.js's own header calls the v7.21.2 defect.
const { test, expect } = require("./isolated-test");
const { apiLogin, freshCtx, TEST_DB_PATH } = require("./helpers");
const { TASK_FIELD_CAPS } = require("../lib/task-fields");

const H = (csrf) => ({ "x-csrf-token": csrf, "content-type": "application/json" });
const Database = () => new (require("better-sqlite3"))(TEST_DB_PATH);

const row = (over = {}) => ({
  title: `ImpShape ${Date.now()}${Math.floor(Math.random() * 1e6)}`,
  description: "d", difficulty: "easy", answer_type: "text", correct_answer: "a",
  ...over,
});
// The wire envelope is { data: {type, tasks}, resolutions } — `resolutions`
// present means EXECUTE, absent means DRY RUN.
const payload = (tasks) => ({ data: { type: "hackarena-tasks", tasks }, resolutions: {} });
const dryRun = (tasks) => ({ data: { type: "hackarena-tasks", tasks } });


// A REAL, structurally valid PNG whose bulk is a private chunk. The pixel cap
// reads the IHDR at fixed offsets and sees 1x1, so only a BYTE cap can stop it —
// which is exactly how the pre-fix pixel-only guard was bypassed by a ~21 MB
// file that imported successfully.
function makeOversizePng(totalBytes) {
  const zlib = require("zlib");
  const crc = (buf) => { let c = ~0; for (const b of buf) { c ^= b; for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1)); } return ~c >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const cc = Buffer.alloc(4); cc.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, cc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 6;
  const overhead = 8 + 25 + 12 + 24 + 12;
  const fillerLen = Math.max(0, totalBytes - overhead);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk("IHDR", ihdr),
    ...(fillerLen ? [chunk("blOb", Buffer.alloc(fillerLen, 0x41))] : []),
    chunk("IDAT", zlib.deflateSync(Buffer.from([0, 0, 0, 0, 0]))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
// v7.20.2 rule: `lib/sanitise` reaches db.js, which OPENS THE DATABASE at
// require time — before the per-file recycle wipes it — so a module-scope
// require would hold a handle on an unlinked inode and read the previous file's
// data. Resolved lazily inside each test, where the harness has already purged
// the module cache. (The repo's own scanner caught this draft.)
const richImgMaxBytes = () => require("../lib/sanitise").RICH_IMG_MAX_BYTES;

test.describe("Challenge import: field shapes, normalisation and caps (v8.3.20)", () => {

  test("a wrong-TYPED field refuses the batch and NAMES the row", async () => {
    const { api: sa, csrf } = await apiLogin("superadmin");
    // Each of these reached a bind before this release. The object and boolean
    // cases produced a bare 500; the ARRAY case was accepted and stored `x`.
    for (const [label, bad] of [
      ["object title", { title: { a: 1 } }],
      ["boolean title", { title: true }],
      ["array title", { title: ["sneaky"] }],
      ["numeric title", { title: 12345 }],
      ["object correct_answer", { correct_answer: {} }],
      ["object active", { active: {} }],
      ["array active", { active: [1] }],
      ["object status", { status: {} }],
    ]) {
      const r = await sa.post("/api/admin/import/tasks", { headers: H(csrf), data: payload([row(), row(bad)]) });
      expect(r.status(), `${label}: expected a named 400, got ${r.status()}`).toBe(400);
      const d = await r.json();
      expect(d.error, `${label}: the refusal must name the row`).toMatch(/Question #2/);
      expect(d.error, `${label}: and must not be the generic 500 text`).not.toMatch(/internal error/i);
    }
    await sa.dispose();
  });

  test("a wrong-typed field is refused on the DRY RUN too, before any write", async () => {
    // The check must run before the dry-run early return: a dry run has no
    // `skipped` channel, so dropping a row there would make the conflict indices
    // the resolution UI sends back disagree with the real import's.
    const { api: sa, csrf } = await apiLogin("superadmin");
    const r = await sa.post("/api/admin/import/tasks", {
      headers: H(csrf), data: dryRun([row({ title: { a: 1 } })]),
    });
    expect(r.status()).toBe(400);
    expect((await r.json()).error).toMatch(/Question #1/);
    await sa.dispose();
  });

  test("a well-typed but unusable value is still SKIPPED, not refused", async () => {
    // The other half of the v7.21.1 posture, and the control that stops this
    // release turning a tolerant importer into a brittle one: a bad ENUM is a
    // property of one row, not of the file.
    const { api: sa, csrf } = await apiLogin("superadmin");
    const good = row();
    const r = await sa.post("/api/admin/import/tasks", {
      headers: H(csrf), data: payload([good, row({ difficulty: "impossible" })]),
    });
    expect(r.ok(), `a bad enum must not sink the batch: ${r.status()} ${await r.text()}`).toBeTruthy();
    const d = await r.json();
    expect(d.imported).toBe(1);
    expect(d.skipped).toBe(1);
    await sa.dispose();
  });

  test("status and active are NORMALISED, matching what the create path stores", async () => {
    // A DOMAIN violation is coerced, not refused — and that distinction is
    // load-bearing rather than lenient. `tasks.active` is INTEGER with no CHECK,
    // the PRE-v8.3.20 importer bound it raw, and the export projects the column
    // VERBATIM: so a deployment carrying rows THIS DEFECT created (`active: 99`,
    // `active: "yes"`) must still be able to export and re-import its own data.
    // Refusing a value the platform's own export emits would strand it, which is
    // worse than the defect. Only an object or array — which better-sqlite3
    // cannot bind at all, and which no export can produce — is a malformed file.
    const { api: sa, csrf } = await apiLogin("superadmin");
    const t1 = row({ status: "published", active: true });
    const t2 = row({ status: "draft", active: false });
    const t3 = row({ status: "published" });   // active omitted → defaults to 1
    const t4 = row({ status: "banana", active: 99 });     // legacy junk, coerced
    const t5 = row({ status: "draft", active: "yes" });   // legacy junk, coerced
    const r = await sa.post("/api/admin/import/tasks", { headers: H(csrf), data: payload([t1, t2, t3, t4, t5]) });
    expect(r.ok(), `${r.status()} ${await r.text()}`).toBeTruthy();
    await sa.dispose();

    const db = Database();
    try {
      for (const [t, wantStatus, wantActive] of [
        [t1, "published", 1], [t2, "draft", 0], [t3, "published", 1],
        [t4, "draft", 1],   // an unrecognised status becomes draft, like create
        [t5, "draft", 1],   // "yes" is truthy → 1, stored as an INTEGER
      ]) {
        const got = db.prepare("SELECT status, active, typeof(active) AS ta FROM tasks WHERE title=?").get(t.title);
        expect(got, `stored row for ${t.title}`).toBeTruthy();
        expect(got.status).toBe(wantStatus);
        expect(got.active).toBe(wantActive);
        // The column is declared INTEGER and every SQL predicate reads it as
        // one; a TEXT value there is the split-brain this normalisation removes.
        expect(got.ta, "active must be stored as an INTEGER").toBe("integer");
      }
    } finally { db.close(); }
  });

  test("PUT /api/admin/tasks/:id refuses a non-flag `active` at ADMIN tier", async () => {
    // The half that escapes the superadmin gate. The create path is unaffected —
    // it hard-codes 1 — so the PUT is the only writer that took a caller value.
    const { api: sa, csrf } = await apiLogin("superadmin");
    const mk = await sa.post("/api/admin/tasks", {
      headers: H(csrf),
      data: { title: `ActiveGuard ${Date.now()}`, description: "d", difficulty: "easy", answer_type: "text", correct_answer: "a" },
    });
    expect(mk.ok(), `create: ${mk.status()} ${await mk.text()}`).toBeTruthy();
    const id = (await mk.json()).id;

    // The PUT is a different question from the import: it takes a value an
    // admin's own client just composed, not a file that may carry legacy rows,
    // so it stays strict. `tasks.active` has no CHECK, and a TEXT value there is
    // a split-brain — SQL predicates read it as INACTIVE, JS predicates as
    // ACTIVE — so nothing on any screen could show it.
    for (const bad of ["yes", 99, {}, []]) {
      const r = await sa.put(`/api/admin/tasks/${id}`, { headers: H(csrf), data: { active: bad } });
      expect(r.status(), `active:${JSON.stringify(bad)} must be a named 400`).toBe(400);
      expect((await r.json()).error).toMatch(/active must be/);
    }
    // The control: a LEGITIMATE value still applies, so this is a guard rather
    // than a wall.
    const okr = await sa.put(`/api/admin/tasks/${id}`, { headers: H(csrf), data: { active: false } });
    expect(okr.ok(), `active:false: ${okr.status()} ${await okr.text()}`).toBeTruthy();
    await sa.dispose();

    const db = Database();
    try {
      const got = db.prepare("SELECT active, typeof(active) AS ta FROM tasks WHERE id=?").get(id);
      expect(got.active).toBe(0);
      expect(got.ta).toBe("integer");
    } finally { db.close(); }
  });

  test("every capped field is clamped AND counted — the v8.3.17 F4 gap", async () => {
    const { api: sa, csrf } = await apiLogin("superadmin");
    const t = row({
      // Three fields, three caps. `correct_answer` and `author_linkedin` carry a
      // TASK_FIELD_CAPS entry that the import did not enforce; `author_name` was
      // sliced without being counted.
      correct_answer: "a".repeat(TASK_FIELD_CAPS.correct_answer + 500),
      author_name: "n".repeat(TASK_FIELD_CAPS.author_name + 500),
      author_linkedin: "https://linkedin.com/in/" + "x".repeat(TASK_FIELD_CAPS.author_linkedin + 500),
    });
    const r = await sa.post("/api/admin/import/tasks", { headers: H(csrf), data: payload([t]) });
    expect(r.ok(), `${r.status()} ${await r.text()}`).toBeTruthy();
    const d = await r.json();
    expect(d.imported).toBe(1);
    // A silent clamp is the v7.21.2 defect: the operator must be told.
    expect(d.fields_truncated, "all three truncations must be REPORTED").toBeGreaterThanOrEqual(3);
    await sa.dispose();

    const db = Database();
    try {
      const got = db.prepare("SELECT correct_answer, author_name, author_linkedin FROM tasks WHERE title=?").get(t.title);
      expect(got.correct_answer.length).toBeLessThanOrEqual(TASK_FIELD_CAPS.correct_answer);
      expect(got.author_name.length).toBeLessThanOrEqual(TASK_FIELD_CAPS.author_name);
      expect((got.author_linkedin || "").length).toBeLessThanOrEqual(TASK_FIELD_CAPS.author_linkedin);
    } finally { db.close(); }
  });

  test("a REAL export round-trips — the shape check must not brick a migration", async () => {
    // THE HIGHEST-VALUE CHECK IN THIS FILE. A field-shape table is only safe if
    // it accepts everything the platform's OWN export emits; a false rejection
    // here bricks the documented backup/migration path rather than catching a
    // malformed file. Driven against a real `GET /api/admin/export/tasks`
    // payload, not a hand-written fixture, because the fixture is exactly what
    // would agree with my mistaken assumptions.
    const { api: sa, csrf } = await apiLogin("superadmin");
    const ex = await sa.get("/api/admin/export/tasks");
    expect(ex.ok(), `export: ${ex.status()}`).toBeTruthy();
    const exported = await ex.json();
    expect(Array.isArray(exported.tasks) && exported.tasks.length, "the seeded database must export some challenges").toBeTruthy();

    // Re-import it under fresh titles so the round trip creates rather than
    // conflicting — the point is that every FIELD SHAPE the export emits is
    // accepted, not the conflict machinery.
    const stamp = Date.now();
    const tasks = exported.tasks.map((t, i) => ({ ...t, title: `RT-${stamp}-${i} ${t.title}` }));
    const r = await sa.post("/api/admin/import/tasks", { headers: H(csrf), data: payload(tasks) });
    expect(r.ok(), `re-import of a REAL export must be accepted: ${r.status()} ${(await r.text()).slice(0, 300)}`).toBeTruthy();
    const d = await r.json();
    expect(d.imported, "every exported challenge must import").toBe(tasks.length);
    expect(d.skipped, "and none may be silently skipped").toBe(0);
    await sa.dispose();
  });

  test("a BLANK title is SKIPPED, not refused — emptiness is not a malformed file", async () => {
    // The posture boundary, and a regression this release nearly shipped. A
    // blank title is WELL-TYPED and merely unimportable, so it belongs with a
    // bad `difficulty` in the SKIP bucket. Refusing it would turn one blank row
    // in a 500-challenge migration into a refused file.
    //
    // WHITESPACE, deliberately, not the empty string: `"   "` is TRUTHY, so it
    // slipped past all three `if (!t.title)` skip guards and was STORED — a row
    // the edit form then refuses to save, because the create path requires
    // `title.trim()`. Found while writing this test; the guards trim now.
    const { api: sa, csrf } = await apiLogin("superadmin");
    const good = row();
    const r = await sa.post("/api/admin/import/tasks", { headers: H(csrf), data: payload([good, row({ title: "   " })]) });
    expect(r.ok(), `a blank title must not sink the batch: ${r.status()} ${await r.text()}`).toBeTruthy();
    const d = await r.json();
    expect(d.imported).toBe(1);
    expect(d.skipped).toBe(1);
    await sa.dispose();
  });

  test("an embedded rich-text image is BYTE-capped, and the row is not stored", async () => {
    // The pixel cap is bypassed by a valid 1x1 IHDR plus filler — the header is
    // read at fixed offsets, so the payload can be arbitrarily large. Measured
    // pre-fix: a ~21 MB "PNG" imported successfully and landed in the `images`
    // table, while the stored description was 94 characters (an
    // `/api/images/<uuid>` reference), so the TASK_FIELD_CAPS clamp could never
    // fire. The cap therefore lives at the SINK in lib/sanitise.js, where all
    // five processRichText call sites converge.
    const png = makeOversizePng(richImgMaxBytes() + 64 * 1024);
    expect(png.length, "the fixture must exceed the cap").toBeGreaterThan(richImgMaxBytes());

    const db0 = Database();
    const before = db0.prepare("SELECT COUNT(*) AS n FROM images").get().n;
    db0.close();

    const { api: sa, csrf } = await apiLogin("superadmin");
    const t = row({ description: `<p>x</p><img src="data:image/png;base64,${png.toString("base64")}">` });
    const r = await sa.post("/api/admin/import/tasks", { headers: H(csrf), data: payload([t]) });
    expect(r.ok(), `${r.status()} ${(await r.text()).slice(0, 200)}`).toBeTruthy();
    await sa.dispose();

    const db = Database();
    try {
      // The row imports — an oversized image is a property of one field, not a
      // reason to sink a 500-challenge migration — but the <img> is STRIPPED and
      // nothing reaches the images table.
      const got = db.prepare("SELECT description FROM tasks WHERE title=?").get(t.title);
      expect(got, "the challenge itself still imports").toBeTruthy();
      expect(got.description).not.toMatch(/<img/i);
      expect(got.description, "the surrounding text survives").toMatch(/x/);
      expect(db.prepare("SELECT COUNT(*) AS n FROM images").get().n,
        "an over-cap image must never reach the images table — that BLOB is inside the backed-up database").toBe(before);
    } finally { db.close(); }
  });

  test("a dropped oversize image is COUNTED and reported, not silently removed", async () => {
    // A silent drop is the v7.21.2 defect this release invokes elsewhere, so the
    // cap has to come with a counter AND a client that renders it. Without this
    // the operator gets a green "imported 1" for a challenge whose screenshot is
    // gone.
    const png = makeOversizePng(richImgMaxBytes() + 32 * 1024);
    const { api: sa, csrf } = await apiLogin("superadmin");
    const t = row({ description: `<p>a</p><img src="data:image/png;base64,${png.toString("base64")}">` });
    const r = await sa.post("/api/admin/import/tasks", { headers: H(csrf), data: payload([t]) });
    expect(r.ok(), `${r.status()} ${(await r.text()).slice(0, 200)}`).toBeTruthy();
    const d = await r.json();
    expect(d.imported).toBe(1);
    expect(d.images_dropped, "the drop must be reported on the response").toBe(1);
    await sa.dispose();

    // …and the client must RENDER it. A counter no client reads is the same
    // defect wearing the response's clothes (v7.21.2).
    const src = require("fs").readFileSync(require("path").join(__dirname, "..", "public", "js", "features", "export-import.js"), "utf8");
    expect(src, "the import toast must surface images_dropped").toMatch(/images_dropped/);
  });

  test("an ordinary screenshot is NOT dropped — the cap bounds bombs, not content", async () => {
    // The regression this cap nearly shipped. A first draft used 2 MB, which is
    // BELOW a genuine 1200x800 screenshot (~2.9 MB of RGB noise, 0.96 MP against
    // a 16 MP pixel cap) — so the byte cap would have been the binding
    // constraint on real content rather than on image bombs, deleting it
    // silently on every import. The fixture is deliberately sized just under a
    // realistic screenshot and well over the old value.
    expect(richImgMaxBytes(), "the cap must clear a realistic screenshot").toBeGreaterThan(3 * 1024 * 1024);
    const png = makeOversizePng(3 * 1024 * 1024);   // ~3 MB: a real screenshot's size
    const db0 = Database();
    const before = db0.prepare("SELECT COUNT(*) AS n FROM images").get().n;
    db0.close();

    const { api: sa, csrf } = await apiLogin("superadmin");
    const t = row({ description: `<p>b</p><img src="data:image/png;base64,${png.toString("base64")}">` });
    const r = await sa.post("/api/admin/import/tasks", { headers: H(csrf), data: payload([t]) });
    expect(r.ok(), `${r.status()} ${(await r.text()).slice(0, 200)}`).toBeTruthy();
    expect((await r.json()).images_dropped, "a screenshot-sized image must NOT be dropped").toBe(0);
    await sa.dispose();

    const db = Database();
    try {
      expect(db.prepare("SELECT COUNT(*) AS n FROM images").get().n).toBe(before + 1);
      expect(db.prepare("SELECT description FROM tasks WHERE title=?").get(t.title).description).toMatch(/\/api\/images\//);
    } finally { db.close(); }
  });

  test("an image UNDER the cap still stores, so the cap is a bound and not a ban", async () => {
    const png = makeOversizePng(0);   // a minimal but genuinely valid PNG
    const db0 = Database();
    const before = db0.prepare("SELECT COUNT(*) AS n FROM images").get().n;
    db0.close();

    const { api: sa, csrf } = await apiLogin("superadmin");
    const t = row({ description: `<p>y</p><img src="data:image/png;base64,${png.toString("base64")}">` });
    const r = await sa.post("/api/admin/import/tasks", { headers: H(csrf), data: payload([t]) });
    expect(r.ok(), `${r.status()} ${await r.text()}`).toBeTruthy();
    await sa.dispose();

    const db = Database();
    try {
      const got = db.prepare("SELECT description FROM tasks WHERE title=?").get(t.title);
      expect(got.description, "an ordinary embedded image must still be stored and referenced").toMatch(/\/api\/images\//);
      expect(db.prepare("SELECT COUNT(*) AS n FROM images").get().n).toBe(before + 1);
    } finally { db.close(); }
  });
});

// ---------------------------------------------------------------------------
// v8.3.39 (external audit) — THE PARTICIPANT IMPORT HAD THE SAME HOLE, IN THE
// FIELDS THAT DECIDE WHO IS AN ADMIN.
//
// v8.3.20 policed the CHALLENGE import's field shapes and left its twin alone.
// The participant importer shape-checks eighteen profile fields and binds
// FOURTEEN MORE straight out of the file as `p.X || <default>` — `role`,
// `created_at`, `login_time`, the approval and denial ladder, the invitation
// trio. better-sqlite3 spreads an array as positional bindings and refuses a
// boolean outright, so one `{"role": true}` threw out of the write transaction
// and 500'd the import. Under the v6.16.4 chunking that is worse than a plain
// crash: the throw aborts chunk K while chunks 0..K-1 stay COMMITTED, and a raw
// 500 carries none of the `partial:` accounting the handler works to keep
// truthful — so the operator is told nothing happened when hundreds of rows
// landed.
//
// AND `users.role` HAS NO CHECK CONSTRAINT, so a well-typed `"wizard"` was
// simply stored. `requireAdmin` tests for the two privileged spellings, so such
// a row behaves as a participant nearly everywhere and renders as itself on the
// admin screen — a value no control on the platform can produce and none can
// explain.
//
// AND THE CREDENTIAL. An imported account is passwordless, as every other
// create is: it stores the fixed NO_PASSWORD_HASH and signs in by an emailed
// code. A per-row bcrypt placeholder once cost a 5,000-row import ~72 seconds of
// the whole libuv pool and opened nothing.
test.describe("Participant import: field shapes, role vocabulary and the stored credential (v8.3.39)", () => {
  const pRow = (over = {}) => {
    const stamp = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
    return {
      nickname: `imp_${stamp}`, email: `imp-${stamp}@company.co`,
      first_name: "Imp", last_name: "Ort", company: "Acme", title: "Eng",
      country: "US", timezone: "America/New_York", job_function: "Other", city: "Town",
      ...over,
    };
  };
  const pPayload = (participants) => ({ data: { type: "hackarena-participants", version: 2, participants }, resolutions: {} });

  test("a wrong-TYPED lifecycle field refuses the batch and NAMES the row", async () => {
    const { api: sa, csrf } = await apiLogin("superadmin");
    // Every one of these reached a bind before this release. The array cases are
    // the sharpest: they do not merely throw, they SHIFT the positional binding
    // list of a 38-placeholder INSERT.
    for (const [label, bad] of [
      ["boolean role", { role: true }],
      ["array role", { role: ["admin"] }],
      ["object role", { role: { r: "admin" } }],
      ["array login_time", { login_time: ["a", "b"] }],
      ["array created_at", { created_at: ["2020-01-01T00:00:00.000Z"] }],
      ["object approved_by", { approved_by: {} }],
      ["numeric denied_reason", { denied_reason: 42 }],
      ["array invitation_id", { invitation_id: ["x"] }],
      ["boolean last_login_time", { last_login_time: false }],
      ["array locked_until", { locked_until: [] }],
      ["object first_verified_at", { first_verified_at: {} }],
      ["array invited_by", { invited_by: ["someone"] }],
    ]) {
      const r = await sa.post("/api/admin/import/participants", { headers: H(csrf), data: pPayload([pRow(), pRow(bad)]) });
      expect(r.status(), `${label}: expected a named 400, got ${r.status()}`).toBe(400);
      const d = await r.json();
      expect(d.error, `${label}: the refusal must name the row`).toMatch(/Participant #2/);
      expect(d.error, `${label}: and must not be the generic 500 text`).not.toMatch(/internal error/i);
    }
    await sa.dispose();
  });

  test("an unrecognised role is DROPPED and COUNTED — the new row imports as a participant", async () => {
    const { api: sa, csrf } = await apiLogin("superadmin");
    const good = pRow({ role: "admin" });
    const bad = pRow({ role: "wizard" });
    const r = await sa.post("/api/admin/import/participants", { headers: H(csrf), data: pPayload([good, bad]) });
    expect(r.status(), await r.text()).toBe(200);
    const d = await r.json();

    // A silent drop is the v7.21.2 defect on the one field that decides who is
    // an admin, so the count has to reach the operator.
    expect(d.invalid_roles_dropped, "the drop is reported").toBe(1);
    expect(d.imported, "and the batch still imports — one bad value is not a refused file").toBe(2);

    const db = Database();
    try {
      const gr = db.prepare("SELECT role FROM users WHERE email=?").get(good.email);
      const br = db.prepare("SELECT role FROM users WHERE email=?").get(bad.email);
      // The CONTROL: a legitimate role still comes through, or "the bad one did
      // not become an admin" is satisfied by a build that ignores role entirely.
      expect(gr.role, "a recognised role is honoured").toBe("admin");
      expect(br.role, "an unrecognised one falls through to the default").toBe("participant");
      expect(br.role).not.toBe("wizard");
    } finally { db.close(); }
    await sa.dispose();
  });

  test("an unrecognised role on an OVERWRITE leaves the stored role ALONE", async () => {
    // The half that matters more, and the reason the fix DROPS the key rather
    // than rewriting it to "participant": with the key deleted, `_has(p,"role")`
    // is false, so the overwrite's dynamic UPDATE never names the column. A
    // malformed file therefore cannot silently demote an existing admin — the
    // `profile_policy` rule (an absent key preserves what is there).
    const { api: sa, csrf } = await apiLogin("superadmin");
    const p = pRow({ role: "admin" });
    expect((await sa.post("/api/admin/import/participants", { headers: H(csrf), data: pPayload([p]) })).status()).toBe(200);

    const db = Database();
    let id;
    try {
      const u = db.prepare("SELECT id, role FROM users WHERE email=?").get(p.email);
      expect(u.role).toBe("admin");
      id = u.id;
    } finally { db.close(); }

    // Same identity, so this is an overwrite; role now malformed.
    const again = { data: { type: "hackarena-participants", version: 2, participants: [{ ...p, role: "wizard" }] },
                    resolutions: { "0": "overwrite" } };
    const r2 = await sa.post("/api/admin/import/participants", { headers: H(csrf), data: again });
    expect(r2.status(), await r2.text()).toBe(200);
    expect((await r2.json()).invalid_roles_dropped).toBe(1);

    const db2 = Database();
    try {
      expect(db2.prepare("SELECT role FROM users WHERE id=?").get(id).role,
        "an existing admin is not demoted by a file that says something unrecognisable").toBe("admin");
    } finally { db2.close(); }
    await sa.dispose();
  });

  test("a CUSTOM role that exists here is honoured, and its unscoped holder keeps `staff` on an overwrite with no tags; another installation's role id is dropped (CONTROL)", async () => {
    // The export emits the role id, so a custom role from Users & roles must
    // round-trip through the import instead of reading as "unrecognised".
    const { api: sa, csrf } = await apiLogin("superadmin");
    const cr = await sa.post("/api/admin/roles", { headers: H(csrf), data: { label: `Import desk ${Date.now()}`, scope_mode: "all", permissions: ["participants.view"] } });
    expect(cr.ok(), await cr.text()).toBeTruthy();
    const roleId = (await cr.json()).role.id;
    const mine = pRow({ role: roleId });
    const foreign = pRow({ role: "role_0123456789ab" });   // the shape of a custom id that names no role here
    const r = await sa.post("/api/admin/import/participants", { headers: H(csrf), data: pPayload([mine, foreign]) });
    expect(r.status(), await r.text()).toBe(200);
    const d = await r.json();
    expect(d.imported).toBe(2);
    expect(d.invalid_roles_dropped, "only the role this installation does not hold is dropped").toBe(1);
    expect(d.role_grants, "the unscoped custom role counts as an admin grant").toBe(1);
    const db = Database();
    let id;
    try {
      const u = db.prepare("SELECT id, role FROM users WHERE email=?").get(mine.email);
      expect(u.role, "the custom role is honoured").toBe(roleId);
      id = u.id;
      expect(db.prepare("SELECT 1 FROM user_tags WHERE user_id=? AND tag='staff'").get(id), "an unscoped role is staff, as the role route makes it").toBeTruthy();
      expect(db.prepare("SELECT role FROM users WHERE email=?").get(foreign.email).role, "CONTROL: an unknown role falls through to the default").toBe("participant");
    } finally { db.close(); }

    // Overwrite the holder from a row that carries no `tags` key: the tag set is
    // rewritten, and the staff tag must come back for the unscoped role.
    const { tags: _omit, ...noTags } = { ...mine };
    const again = { data: { type: "hackarena-participants", version: 2, participants: [noTags] }, resolutions: { "0": "overwrite" } };
    const r2 = await sa.post("/api/admin/import/participants", { headers: H(csrf), data: again });
    expect(r2.status(), await r2.text()).toBe(200);
    expect((await r2.json()).invalid_roles_dropped).toBe(0);
    const db2 = Database();
    try {
      expect(db2.prepare("SELECT role FROM users WHERE id=?").get(id).role).toBe(roleId);
      expect(db2.prepare("SELECT 1 FROM user_tags WHERE user_id=? AND tag='staff'").get(id), "the holder stays off the leaderboards").toBeTruthy();
    } finally { db2.close(); }
    await sa.dispose();
  });

  test("an importer who is NOT a superadmin (a custom role holding data.import) gives no role beyond its own and overwrites no account only a superadmin manages; a superadmin imports the same rows (CONTROL)", async () => {
    // The escalation rule (lib/rbac.js roleAssignDenied) and the privileged-
    // target rule (privilegedTargetFor) hold at the import too: any role holding
    // `data.import` reaches it, and a file must not do what the role route and
    // the account doors refuse that importer.
    const { PARTICIPANT_PASS } = require("./helpers");
    const { makeParticipant } = require("./event-admin-helpers");
    const { api: sa, csrf } = await apiLogin("superadmin");
    const mkRole = async (label, scope_mode, permissions) => {
      const r = await sa.post("/api/admin/roles", { headers: H(csrf), data: { label: `${label} ${Date.now()}${Math.floor(Math.random() * 1e4)}`, scope_mode, permissions } });
      expect(r.ok(), `create ${label}: ${await r.text()}`).toBeTruthy();
      return (await r.json()).role.id;
    };
    const importerRole = await mkRole("Importer", "all", ["data.import", "participants.view"]);
    const viewerRole = await mkRole("Import viewer", "granted", ["participants.view"]);
    const importer = await makeParticipant(sa, csrf, "importer");
    expect((await sa.patch(`/api/admin/users/${importer.id}/role`, { headers: H(csrf), data: { role: importerRole } })).ok()).toBeTruthy();
    const peer = await makeParticipant(sa, csrf, "imppeer");
    expect((await sa.post(`/api/admin/participants/${peer.id}/role`, { headers: H(csrf), data: { role: "admin" } })).ok()).toBeTruthy();
    const plain = await makeParticipant(sa, csrf, "impplain");
    const readRow = (email) => { const db = Database(); try { return db.prepare("SELECT role, last_name FROM users WHERE email=? COLLATE NOCASE").get(email); } finally { db.close(); } };
    const peerBefore = readRow(peer.email);

    const rows = [
      pRow({ role: "superadmin" }),                                  // 0: a role only a superadmin gives
      pRow({ role: "admin" }),                                       // 1: a role holding more than the importer's
      pRow({}),                                                      // 2: CONTROL: a participant
      pRow({ role: viewerRole }),                                    // 3: CONTROL: a role inside the importer's own
      pRow({ email: peer.email, nickname: `imp_peer_${Date.now()}`, last_name: "Overwritten" }),  // 4: an admin's account
      pRow({ email: plain.email, nickname: `imp_plain_${Date.now()}`, last_name: "Overwritten" }), // 5: CONTROL: a participant's
    ];
    const body = { data: { type: "hackarena-participants", version: 2, participants: rows }, resolutions: { "4": "overwrite", "5": "overwrite" } };
    const li = await apiLogin(importer.email, PARTICIPANT_PASS);
    try {
      const r = await li.api.post("/api/admin/import/participants", { headers: H(li.csrf), data: body });
      expect(r.status(), `the importer's import: ${await r.text()}`).toBe(200);
      const d = await r.json();
      expect({ imported: d.imported, overwritten: d.overwritten, privileged_skipped: d.privileged_skipped },
        "two rows and the participant's overwrite land; the rest are skipped and counted").toEqual({ imported: 2, overwritten: 1, privileged_skipped: 3 });
    } finally { await li.api.dispose(); }
    expect(readRow(rows[0].email), "no superadmin was made").toBeUndefined();
    expect(readRow(rows[1].email), "no admin was made").toBeUndefined();
    expect(readRow(rows[2].email).role, "CONTROL: the participant row lands").toBe("participant");
    expect(readRow(rows[3].email).role, "CONTROL: a role inside the importer's own lands").toBe(viewerRole);
    expect(readRow(peer.email), "the admin's account is untouched").toEqual(peerBefore);
    expect(readRow(plain.email).last_name, "CONTROL: the participant's account is overwritten").toBe("Overwritten");

    // CONTROL: the superadmin imports the same kind of rows.
    const again = [pRow({ role: "admin" }), pRow({ email: peer.email, nickname: `imp_peer2_${Date.now()}`, last_name: "BySuperadmin" })];
    const r2 = await sa.post("/api/admin/import/participants", { headers: H(csrf), data: { data: { type: "hackarena-participants", version: 2, participants: again }, resolutions: { "1": "overwrite" } } });
    expect(r2.status(), await r2.text()).toBe(200);
    const d2 = await r2.json();
    expect({ imported: d2.imported, overwritten: d2.overwritten, privileged_skipped: d2.privileged_skipped }).toEqual({ imported: 1, overwritten: 1, privileged_skipped: 0 });
    expect(readRow(again[0].email).role).toBe("admin");
    expect(readRow(peer.email).last_name).toBe("BySuperadmin");
    await sa.dispose();
  });

  test("a wrong-typed profile_policy on an OVERWRITE does not sink the batch", async () => {
    // The one member of _V2_AUDIT_FIELDS deliberately absent from the row-shape
    // map: the INSERT branch COERCES a non-string `profile_policy` to NULL rather
    // than refusing the file ("there is no value worth risking a 500 to
    // preserve"), so listing it would contradict that. The OVERWRITE branch
    // builds its column list and its bind list dynamically and had no such
    // coercion, so this shape reached SQLite — the one site a row-level check
    // structurally cannot cover.
    const { api: sa, csrf } = await apiLogin("superadmin");
    const p = pRow();
    expect((await sa.post("/api/admin/import/participants", { headers: H(csrf), data: pPayload([p]) })).status()).toBe(200);

    const again = { data: { type: "hackarena-participants", version: 2,
                            participants: [{ ...p, profile_policy: ["booth"] }] },
                    resolutions: { "0": "overwrite" } };
    const r = await sa.post("/api/admin/import/participants", { headers: H(csrf), data: again });
    expect(r.status(), `an unbindable profile_policy must not 500 the import: ${await r.text()}`).toBe(200);
    expect((await r.json()).overwritten).toBe(1);

    const db = Database();
    try {
      const u = db.prepare("SELECT profile_policy FROM users WHERE email=?").get(p.email);
      expect(u.profile_policy, "it degrades to NULL, exactly as the INSERT branch does").toBeNull();
    } finally { db.close(); }
    await sa.dispose();
  });

  test("a wrong-typed value nested in competitions[] does not sink the batch", async () => {
    // v8.3.34 (F6) guarded every bind in `absences[]` and left this, its twin,
    // untouched; v8.3.35 fixed the `timeslot_name` lookup THERE and recorded the
    // same shape here as pre-existing. All three values reach a bind.
    const { api: sa, csrf } = await apiLogin("superadmin");
    const p = pRow({ competitions: [
      { competition_name: "Test Live", timeslot_name: ["a", "b"] },
      { competition_name: "Test Live", assigned_at: ["x"], login_time: {} },
    ] });
    const r = await sa.post("/api/admin/import/participants", { headers: H(csrf), data: pPayload([p]) });
    expect(r.status(), `a malformed nested value must not 500 the import: ${await r.text()}`).toBe(200);
    expect((await r.json()).imported).toBe(1);

    const db = Database();
    try {
      const u = db.prepare("SELECT id FROM users WHERE email=?").get(p.email);
      expect(u, "the participant still imported").toBeTruthy();
      const cu = db.prepare("SELECT login_time, assigned_at FROM competition_users WHERE user_id=?").all(u.id);
      expect(cu.length, "the usable entry DID land — or the loop below checks nothing").toBeGreaterThan(0);
      // The second entry is applied with its unusable timestamps degraded to
      // NULL / the import clock; the first is skipped, because binding the slot
      // name IS the lookup and there is nothing to degrade to.
      for (const row of cu) expect(typeof row.assigned_at, "assigned_at is a real timestamp").toBe("string");
    } finally { db.close(); }
    await sa.dispose();
  });

  test("a REAL participant export round-trips — the widened check must not brick a migration", async () => {
    // The v8.3.20 rule, applied to the fields this release added to the map:
    // refusing a value the platform's own export emits strands the data. Drive a
    // genuine export through the importer rather than a hand-written fixture.
    const { api: sa, csrf } = await apiLogin("superadmin");
    const ex = await sa.get("/api/admin/export/participants");
    expect(ex.status()).toBe(200);
    const data = await ex.json();
    expect(Array.isArray(data.participants) && data.participants.length, "the export has rows to re-import").toBeTruthy();

    const dry = await sa.post("/api/admin/import/participants", { headers: H(csrf), data: { data } });
    expect(dry.status(), `the platform's own export must import: ${await dry.text()}`).toBe(200);
    const d = await dry.json();
    expect(d.dryRun).toBe(true);
    // And nothing in it trips the role vocabulary, which would mean the export
    // is emitting a value the importer refuses to store: every exported role
    // names a role of this installation (built-in or custom; `roles` holds both).
    const roles = new Set(data.participants.map(p => p.role).filter(Boolean));
    expect(roles.size, "the export carries roles to check").toBeGreaterThan(0);
    const db = Database();
    let known;
    try { known = new Set(db.prepare("SELECT id FROM roles").all().map(r => r.id)); } finally { db.close(); }
    expect(known.has("participant") && known.has("admin"), "PRECONDITION: the built-in roles are rows of `roles`").toBe(true);
    for (const r of roles) expect(known.has(r), `exported role ${r} is one the importer recognises`).toBe(true);
    await sa.dispose();
  });

  test("an imported account stores no password; an overwrite leaves the stored hash alone (CONTROL)", async () => {
    const { NO_PASSWORD_HASH } = require("../lib/util");
    const { hasUsablePassword } = require("../lib/login-method");
    const { api: sa, csrf } = await apiLogin("superadmin");
    const p = pRow();
    expect((await sa.post("/api/admin/import/participants", { headers: H(csrf), data: pPayload([p]) })).status()).toBe(200);

    const read = () => {
      const db = Database();
      try { return db.prepare("SELECT id, password_hash, password_set_at FROM users WHERE email=?").get(p.email); } finally { db.close(); }
    };
    const u = read();
    expect(u, "the row was imported").toBeTruthy();
    expect(u.password_hash, "the fixed no-password placeholder, as every other create stores").toBe(NO_PASSWORD_HASH);
    expect(u.password_set_at, "no password was set").toBeNull();
    expect(hasUsablePassword(u), "so nothing signs in by password").toBe(false);
    // ...and the password door (the one that takes an address and a password)
    // refuses it: 200 with ok:false, as for every refusal there.
    const passwordDoor = async (password) => {
      const { api, csrf: c } = await freshCtx();
      try {
        const r = await api.post("/api/auth/password", { headers: H(c), data: { email: p.email, password } });
        expect(r.status(), await r.text()).toBe(200);
        return (await r.json()).ok;
      } finally { await api.dispose(); }
    };
    for (const guess of ["password", p.email, "its-own-password-1"]) {
      expect(await passwordDoor(guess), `"${guess}" does not open an imported account`).toBe(false);
    }

    // CONTROL: an overwrite writes no credential. Give the account a hash of its
    // own, import the same identity again as an overwrite, and the hash stays.
    const own = require("bcrypt").hashSync("its-own-password-1", 4);
    const dbw = Database();
    try { dbw.prepare("UPDATE users SET password_hash=? WHERE id=?").run(own, u.id); } finally { dbw.close(); }
    const again = { data: { type: "hackarena-participants", version: 2, participants: [{ ...p, city: "Elsewhere" }] }, resolutions: { "0": "overwrite" } };
    const r2 = await sa.post("/api/admin/import/participants", { headers: H(csrf), data: again });
    expect(r2.status(), await r2.text()).toBe(200);
    expect((await r2.json()).overwritten, "PRECONDITION: the row was overwritten").toBe(1);
    const v = read();
    expect(v.id, "the same account").toBe(u.id);
    expect(v.password_hash, "an overwrite leaves the stored hash alone").toBe(own);

    // POSITIVE CONTROL for the door: once the account really holds a password
    // (stamped, and signing in by password), the same door opens with it, and a
    // wrong one still does not. So the refusals above are the door's answer to an
    // imported account, not a door that refuses everyone.
    const dbp = Database();
    try { dbp.prepare("UPDATE users SET password_set_at=?, login_method='password' WHERE id=?").run(new Date().toISOString(), u.id); } finally { dbp.close(); }
    expect(await passwordDoor("its-own-password-1"), "CONTROL: a real password opens the door").toBe(true);
    expect(await passwordDoor("not-its-password"), "CONTROL: a wrong one does not").toBe(false);
    await sa.dispose();
  });

  // 9.2.18 — AN AVATAR LINK MUST NAME A STORED PICTURE, AND A REPLACED AVATAR IS
  // RECLAIMED ONLY AFTER THE LAST ROW. Only a hand-edited file carries a raw
  // `/api/images/<id>` avatar (the export inlines every picture). Such a link
  // was stored without asking whether the picture exists, and an earlier row's
  // overwrite reclaimed the avatar it replaced at once, although a later row of
  // the same file named it.
  test("an avatar link to no stored picture is not stored and is counted (shown in the summary); a replaced avatar a later row names is kept, and one nothing names is reclaimed", async ({ page }) => {
    const { BASE, getSuperadminPass } = require("./helpers");
    const crypto = require("crypto");
    const { api: sa, csrf } = await apiLogin("superadmin");
    const PNG = (seed) => require("./helpers").pngDataUri(8, seed);
    const readAvatar = (email) => { const db = Database(); try { return db.prepare("SELECT avatar FROM users WHERE email=?").get(email)?.avatar; } finally { db.close(); } };
    const imageExists = (ref) => { const db = Database(); try { return !!db.prepare("SELECT 1 FROM images WHERE id=?").get(String(ref).slice("/api/images/".length)); } finally { db.close(); } };
    // Three accounts, each with a stored photo (an import stores a data: avatar).
    const x = pRow({ avatar: PNG(`x${Date.now()}`) });
    const w = pRow({ avatar: PNG(`w${Date.now()}`) });
    const v = pRow({ avatar: PNG(`v${Date.now()}`) });
    const r0 = await sa.post("/api/admin/import/participants", { headers: H(csrf), data: pPayload([x, w, v]) });
    expect(r0.status(), await r0.text()).toBe(200);
    const refX = readAvatar(x.email), refW = readAvatar(w.email), refV = readAvatar(v.email);
    expect([refX, refW, refV].every(r => /^\/api\/images\/[0-9a-f-]+$/.test(r) && imageExists(r)), "PRECONDITION: three stored photos").toBe(true);

    const dead = `/api/images/${crypto.randomUUID()}`;
    const y = pRow({ avatar: refX });   // a new account naming ANOTHER account's photo (the one row 0 replaces)
    const z = pRow({ avatar: dead });   // a new account linking to nothing
    const rows = [
      { ...x, avatar: "🦊" },            // 0: overwrite X, replacing its photo
      y,                                 // 1
      z,                                 // 2
      { ...w, avatar: dead },            // 3: overwrite W with a link to nothing
      { ...v, avatar: refV },            // 4: overwrite V naming its OWN current photo
    ];
    const r = await sa.post("/api/admin/import/participants", { headers: H(csrf),
      data: { data: { type: "hackarena-participants", version: 2, participants: rows }, resolutions: { "0": "overwrite", "3": "overwrite", "4": "overwrite" } } });
    expect(r.status(), await r.text()).toBe(200);
    const d = await r.json();
    expect({ imported: d.imported, overwritten: d.overwritten }, "PRECONDITION: every row landed").toEqual({ imported: 2, overwritten: 3 });
    expect(d.avatar_links_dropped, "two links to no picture and one to another account's photo are counted").toBe(3);
    expect(readAvatar(z.email), "a new account linking to nothing gets the default").toBe("default1");
    expect(readAvatar(w.email), "an overwrite linking to nothing keeps the current photo").toBe(refW);
    expect(imageExists(refW)).toBe(true);
    expect(readAvatar(x.email), "CONTROL: X's own overwrite landed").toBe("🦊");
    expect(readAvatar(y.email), "a file cannot hand one account another person's photo").toBe("default1");
    expect(imageExists(refX), "X's replaced photo, which nothing names now, is reclaimed once the import ends").toBe(false);
    expect(readAvatar(v.email), "CONTROL: an overwrite naming its own current photo keeps it").toBe(refV);
    expect(imageExists(refV), "CONTROL: and its photo stays").toBe(true);

    // CONTROL: a replaced photo nothing names is reclaimed once the import ends.
    const r2 = await sa.post("/api/admin/import/participants", { headers: H(csrf),
      data: { data: { type: "hackarena-participants", version: 2, participants: [{ ...w, avatar: "🐼" }] }, resolutions: { "0": "overwrite" } } });
    expect(r2.status(), await r2.text()).toBe(200);
    expect((await r2.json()).avatar_links_dropped, "CONTROL: nothing dropped").toBe(0);
    expect(readAvatar(w.email)).toBe("🐼");
    expect(imageExists(refW), "the replaced photo, named by nothing, is reclaimed").toBe(false);
    await sa.dispose();

    // The operator is told: the summary the import toast shows, from this response.
    const { csrfToken } = await (await page.request.get(`${BASE}/api/csrf-token`)).json();
    const li = await page.request.post(`${BASE}/api/login`, { headers: H(csrfToken), data: { email: "superadmin", password: getSuperadminPass() } });
    expect(li.ok()).toBeTruthy();
    await page.goto(`${BASE}/`);
    await page.locator("#admin-page").waitFor({ state: "visible", timeout: 30000 });
    expect(await page.evaluate((dd) => window._importDropNote(dd), d))
      .toContain("3 avatars were not imported because they link to a picture this platform does not hold, or to another account's");
    expect(await page.evaluate((dd) => window._importDropNote(dd), { ...d, avatar_links_dropped: 0 }), "CONTROL: nothing dropped, nothing said about avatars").not.toContain("avatar");
  });
});
