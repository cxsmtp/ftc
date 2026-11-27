// @ts-check
// ─────────────────────────────────────────────────────────────────────────────
// A LARGE IMPORT LETS THE SERVER ANSWER OTHER REQUESTS.
//
// Measured on 10 000 challenges, the challenge import held the event loop for
// 6.5 s in one stretch: its transaction sanitised every row's description,
// explanation and hint (sanitize-html, 2.5 s of it). The sanitising reads only
// the file, so it now runs in a pass ahead of the commit-time re-check, letting
// queued requests run between slices, and the transaction binds what it
// produced. Storing a field's embedded images is a WRITE (an `images` row per
// picture), so that half of processRichText stays in the transaction, for the
// rows it writes: a skipped row, or an import refused at the commit-time
// re-check, stores no image, and `fields_truncated` counts only rows written.
//
// The participant import's own stall was its conflict scan: every row asked
// `LOWER(email)=LOWER(?) OR LOWER(secondary_email)=LOWER(?)`, which no index
// serves, so 5 000 rows against 10 000 accounts read every account 5 000 times
// (7.4 s, the dry run included). It asks lib/account-lookup.js's indexed
// `findUserByAddress` now, with the same answers.
//
// The event-loop witness is the server's own (GET /api/test/import-prepass): the
// pass's and the transaction's CPU time on the main thread, the longest the loop
// went without a turn while the pass ran, and the responses finished meanwhile,
// beside the commit-time park's counter (whether the import had reached it yet)
// read by the client. Never a wall-clock span: a runner busy with other work
// pauses the server, stretching wall time and not the work in it.
// ─────────────────────────────────────────────────────────────────────────────
const { test, expect } = require("./isolated-test");
const Database = require("better-sqlite3");
const fs = require("fs");
const path = require("path");
const { apiLogin, TEST_DB_PATH, PARTICIPANT_PASS, pngDataUri } = require("./helpers");
const { H, uniq } = require("./event-admin-helpers");
const { signIn, makeAdmin, parked } = require("./admin-inflight-helpers");
const { stripJsComments } = require("./doc-registry");

function dbGet(sql, ...a) { const d = new Database(TEST_DB_PATH, { readonly: true }); try { return d.prepare(sql).get(...a); } finally { d.close(); } }
const imageCount = () => dbGet("SELECT COUNT(*) c FROM images").c;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const tasksFile = (tasks, resolutions = {}) => ({ data: { type: "hackarena-tasks", tasks }, resolutions });

// ~50 KB of styled spans and ~38 KB of table cells: markup sanitize-html spends
// real time on (about 1 s for 40 rows on a developer machine), each field under
// its 65 536-character cap once sanitised, with a payload in every field that
// sanitising must remove.
const span = (k) => `<span style="color:#d33;background-color:#eee;font-size:12px">w${k}</span> `;
const cell = (k) => `<tr><td style="text-align:center;background-color:#eee">c${k}</td><td colspan="2">d</td></tr>`;
function richRow(i, tag) {
  return {
    title: `${tag} ${i}`, difficulty: "easy", answer_type: "text", correct_answer: "a", status: "draft",
    description: `<p>Row ${i} ${tag} opens</p>` + Array.from({ length: 700 }, (_, k) => span(k)).join("")
      + `<script>alert('d${i}')</script><img src="x" onerror="alert(1)"><p>Row ${i} ${tag} closes</p>`,
    explanation: `<p>Why ${i}</p><table><tbody>` + Array.from({ length: 420 }, (_, k) => cell(k)).join("") + `</tbody></table>`
      + `<iframe src="https://evil.example/${i}"></iframe><a href="javascript:alert(2)">j</a><p>Because ${tag}</p>`,
    hint: `<p>Hint ${i} <b onmouseover="steal()">bold</b><script>alert(3)</script></p>`,
  };
}

/** A challenge made through the editor, for the import to collide with by title. */
async function makeTask(sa, csrf, label, extra = {}) {
  const title = `${label} ${uniq("t")}`;
  const r = await sa.post("/api/admin/tasks", { headers: H(csrf), data: {
    title, description: "<p>kept as it was</p>", difficulty: "easy", answer_type: "text", correct_answer: "before", status: "draft", ...extra } });
  expect(r.ok(), `create task: ${r.status()} ${await r.text()}`).toBeTruthy();
  return { id: (await r.json()).id, title };
}

test.describe("The challenge import sanitises its rich text before its transaction", () => {
  let sa, saCsrf;
  test.beforeAll(async () => { ({ api: sa, csrf: saCsrf } = await apiLogin("superadmin")); });
  test.afterAll(async () => { await sa?.dispose(); });

  test("the server keeps answering while a large import's rich text is sanitised, and that happens before the commit-time park; CONTROL: what it stores is sanitised", async () => {
    const tag = uniq("Prepass");
    const ROWS = 40;
    const rows = Array.from({ length: ROWS }, (_, i) => richRow(i, tag));
    const arm = await sa.post("/api/test/admin-commit-delay", { data: { delayMs: 5000 } });
    expect(arm.ok(), `arm the commit park: ${arm.status()}`).toBeTruthy();
    let res, before = 0;
    try {
      const sent = Date.now();   // a safety net for a hung import, never a measurement
      const pending = sa.post("/api/admin/import/tasks", { headers: H(saCsrf), data: tasksFile(rows) });
      // Each answer says whether the import had reached the park yet, so an
      // answer with `parked: 0` is one the server gave while the import was
      // still ahead of it: receiving the file, checking it, sanitising it.
      for (;;) {
        const st = await (await sa.get("/api/test/admin-commit-delay")).json();
        if (st.parked >= 1) break;
        before++;
        if (Date.now() - sent > 60_000) throw new Error("PRECONDITION: the import never reached the commit park");
        await sleep(5);
      }
      const rel = await sa.post("/api/test/admin-commit-delay", { data: { release: true } });
      expect(rel.ok(), "release the parked import").toBeTruthy();
      res = await pending;
    } finally {
      const d = await sa.post("/api/test/admin-commit-delay", { data: { delayMs: 0 } });
      expect(d.ok(), "disarm the commit park").toBeTruthy();
    }
    const body = await res.json();
    expect(res.status(), JSON.stringify(body).slice(0, 300)).toBe(200);
    expect(body.imported, "every row was written").toBe(ROWS);
    expect(body.fields_truncated, "PRECONDITION: no field reached its cap").toBe(0);

    // What the server measured of this import, in its main thread's CPU time: a
    // runner that pauses the process stretches wall-clock spans, never this.
    const w = (await (await sa.get("/api/test/import-prepass")).json()).pass;
    const why = `${JSON.stringify(w)}; ${before} answers before the park`;
    expect(w && w.rows, `PRECONDITION: the witness is this import's, every row through the pass (${why})`).toBe(ROWS);
    expect(w.txnCpuMs, `PRECONDITION: the transaction ran and was measured (${why})`).toEqual(expect.any(Number));
    // The sanitising happened BEFORE the park: the pass had ended when the import
    // entered it, and the rich-text work is the pass's, not the transaction's.
    // Sanitised inside the transaction, its CPU time would sit there instead.
    expect(w.parkedWhenPassEnded, `the pass ends before the import enters the commit-time park (${why})`).toBe(0);
    expect(w.txnCpuMs, `the rich-text work runs ahead of the transaction, not in it (${why})`).toBeLessThan(w.passCpuMs / 2);
    // …and it gave the event loop back while it ran: the server kept answering
    // during the pass itself (an unbroken pass answers nobody, exactly 0) and
    // while the import was ahead of the park, as the client saw it.
    expect(w.answeredDuringPass, `the server answered requests while the pass ran (${why})`).toBeGreaterThanOrEqual(3);
    expect(before, `the server answered while the import was ahead of the park (${why})`).toBeGreaterThanOrEqual(10);
    // No stretch of it held the loop for long: a fixed bound, half of a deadline,
    // with the control that the pass's own work exceeds it, so an unbroken pass
    // would break the bound. A stretch is a slice (IMPORT_RICH_TEXT_SLICE_MS of
    // work, plus the row in hand when it ran out) and the turn that followed it.
    const STALL_DEADLINE_MS = 300;
    expect(w.passCpuMs, `CONTROL: the pass's own work is longer than the bound (${why})`).toBeGreaterThan(STALL_DEADLINE_MS / 2);
    expect(w.longestHoldCpuMs, `no stretch of the pass held the event loop past the bound (${why})`).toBeLessThan(STALL_DEADLINE_MS / 2);

    // CONTROL: what the import stored is the sanitised text, in all three fields.
    const d = new Database(TEST_DB_PATH, { readonly: true });
    try {
      for (const i of [0, ROWS - 1]) {
        const t = d.prepare("SELECT description, explanation, hint FROM tasks WHERE title=?").get(`${tag} ${i}`);
        expect(t, `row ${i} stored`).toBeTruthy();
        expect(t.description).not.toMatch(/<script|onerror|<img/i);
        expect(t.description).toContain(`<p>Row ${i} ${tag} closes</p>`);
        expect(t.description).toContain(span(699).trim());
        expect(t.explanation).not.toMatch(/<iframe|javascript:/i);
        expect(t.explanation).toContain(`<p>Because ${tag}</p>`);
        expect(t.hint).toBe(`<p>Hint ${i} <b>bold</b></p>`);
      }
    } finally { d.close(); }
  });

  test("a row the transaction skips stores no image and counts no truncation; CONTROL: the row written beside it stores and counts its own", async () => {
    const kept = await makeTask(sa, saCsrf, "Kept");      // a conflict the file says to keep
    const locked = await makeTask(sa, saCsrf, "Locked");  // a conflict the file says to overwrite, locked meanwhile
    const lk = await sa.post(`/api/admin/tasks/${locked.id}/lock`, { headers: H(saCsrf) });
    expect(lk.ok(), `lock: ${await lk.text()}`).toBeTruthy();
    expect((await lk.json()).locked, "PRECONDITION: the challenge is locked (the route toggles)").toBe(1);
    const fresh = `Fresh ${uniq("t")}`;
    const long = "x".repeat(70_000);   // sanitised as it is: over the 65 536-character explanation cap
    const img = (seed) => `<p>${seed}</p><img src="${pngDataUri(2, seed)}">`;
    const file = [
      { title: kept.title, difficulty: "easy", answer_type: "text", correct_answer: "a", description: img("kept"), explanation: long },
      { title: locked.title, difficulty: "easy", answer_type: "text", correct_answer: "a", description: img("locked") },
      { title: fresh, difficulty: "easy", answer_type: "text", correct_answer: "a", description: img("fresh"), explanation: long },
    ];
    const dry = await (await sa.post("/api/admin/import/tasks", { headers: H(saCsrf), data: { data: { type: "hackarena-tasks", tasks: file } } })).json();
    expect(dry.conflicts.map(c => c.index).sort(), "PRECONDITION: rows 0 and 1 collide by title").toEqual([0, 1]);

    const imagesBefore = imageCount();
    const r = await sa.post("/api/admin/import/tasks", { headers: H(saCsrf), data: tasksFile(file, { "0": "keep", "1": "overwrite" }) });
    const body = await r.json();
    expect(r.status(), JSON.stringify(body)).toBe(200);
    expect(body.imported, "the fresh row is written").toBe(1);
    expect(body.skipped, "the kept and the locked rows are skipped").toBe(2);
    expect(body.fields_truncated, "only the written row's clamp is counted, not the skipped row's").toBe(1);

    expect(imageCount(), "only the written row's image is stored").toBe(imagesBefore + 1);
    const desc = dbGet("SELECT description FROM tasks WHERE title=?", fresh).description;
    const ref = (desc.match(/\/api\/images\/([0-9a-f-]+)/) || [])[1];
    expect(ref, `CONTROL: the written row references its stored image: ${desc}`).toBeTruthy();
    expect(dbGet("SELECT COUNT(*) c FROM images WHERE id=?", ref).c, "…and that row exists").toBe(1);
    expect(dbGet("SELECT description FROM tasks WHERE id=?", kept.id).description, "the kept challenge is untouched").toBe("<p>kept as it was</p>");
    expect(dbGet("SELECT description FROM tasks WHERE id=?", locked.id).description, "the locked challenge is untouched").toBe("<p>kept as it was</p>");
  });

  test("an import refused at the commit-time re-check stores no image; CONTROL: an untouched importer's same import does", async () => {
    const run = async (label, act) => {
      const imp = await makeAdmin(sa, saCsrf, label, "superadmin");
      const s = await signIn(imp.email, PARTICIPANT_PASS);
      const title = `Refused ${uniq("t")}`;
      try {
        const imagesBefore = imageCount();
        const r = await parked(sa, () => s.api.post("/api/admin/import/tasks", { headers: H(s.csrf), data: tasksFile([
          { title, difficulty: "easy", answer_type: "text", correct_answer: "a", description: `<p>pic</p><img src="${pngDataUri(2, label)}">` }]) }),
          act ? act(imp.id) : null, 1500);
        return { status: r.status(), body: await r.json(), stored: dbGet("SELECT COUNT(*) c FROM tasks WHERE title=?", title).c, images: imageCount() - imagesBefore };
      } finally { await s.api.dispose(); }
    };
    const block = (id) => async () => {
      const r = await sa.post(`/api/admin/participants/${id}/block`, { headers: H(saCsrf) });
      expect(r.ok(), `block: ${await r.text()}`).toBeTruthy();
      expect((await r.json()).blocked, "the block took (the route toggles)").toBe(1);
    };
    const ok = await run("rtpok", null);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.stored, "CONTROL: the untouched importer's challenge lands").toBe(1);
    expect(ok.images, "CONTROL: …with its image").toBe(1);
    const refused = await run("rtpblk", block);
    expect(refused.status, JSON.stringify(refused.body)).toBe(403);
    expect(refused.body.code, "refused at the commit-time re-check").toBe("admin_access_revoked");
    expect(refused.stored, "nothing was written").toBe(0);
    expect(refused.images, "and the image sanitised before the re-check was not stored").toBe(0);
  });

  test("source: the import transaction sanitises nothing, and the pass ahead of the commit-time park does and yields", () => {
    const src = stripJsComments(fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8"));
    const start = src.indexOf('app.post("/api/admin/import/tasks"');
    const end = src.indexOf('app.post("/api/admin/import/participants"', start);
    expect(start, "anti-vacuity: the challenge import route is found").toBeGreaterThan(0);
    expect(end, "anti-vacuity: the route ends where the participant import begins").toBeGreaterThan(start);
    const route = src.slice(start, end);
    const txAt = route.indexOf("const importTxn = db.transaction(");
    expect(txAt, "anti-vacuity: the import transaction is found").toBeGreaterThan(0);
    const open = route.indexOf("(", route.indexOf("db.transaction(", txAt));
    let depth = 0, close = -1;
    for (let k = open; k < route.length; k++) {
      if (route[k] === "(") depth++;
      else if (route[k] === ")" && --depth === 0) { close = k; break; }
    }
    expect(close, "anti-vacuity: the transaction body is delimited").toBeGreaterThan(open);
    const txBody = route.slice(open, close);
    expect(txBody.length, "anti-vacuity: the body is the whole transaction").toBeGreaterThan(5000);
    // The image half stays inside: it writes, so it rolls back with the rows.
    expect(txBody, "the transaction stores the images of the rows it writes").toMatch(/\bextractAndStoreImages\(/);
    expect(txBody, "the transaction sanitises nothing (the pass ahead of it does)").not.toMatch(/\b(?:sanitiseRichText|processRichText)\(/);
    const pass = route.indexOf("sanitiseRichText(");
    const park = route.indexOf("testAdminCommitPark(");
    const authz = route.indexOf("adminAuthzDenied(");
    expect(pass, "the route sanitises").toBeGreaterThan(0);
    expect(park, "the sanitising pass runs before the commit-time park").toBeGreaterThan(pass);
    expect(authz, "…and so before the commit-time re-check").toBeGreaterThan(park);
    expect(txAt, "…and before the transaction").toBeGreaterThan(authz);
    expect(route.slice(pass, park), "the pass lets queued requests run between slices").toMatch(/\bawait\s+new\s+Promise\(\s*\(?\s*r\s*\)?\s*=>\s*setImmediate\(\s*r\s*\)\s*\)/);
    // …and it stores nothing: the image half writes, so outside the transaction
    // it would outlive a rollback, a refusal or a skipped row in any field.
    expect(route.slice(0, txAt), "nothing ahead of the transaction stores an image").not.toMatch(/\b(?:extractAndStoreImages|processRichText)\(/);
  });
});

test.describe("The participant import finds its conflicts by index", () => {
  let sa, saCsrf;
  test.beforeAll(async () => { ({ api: sa, csrf: saCsrf } = await apiLogin("superadmin")); });
  test.afterAll(async () => { await sa?.dispose(); });

  const person = (u, over = {}) => ({
    nickname: `p_${u}`, email: `p-${u}@company.co`, first_name: "Imp", last_name: "Ort",
    company: "Acme", title: "Eng", country: "US", timezone: "America/New_York", job_function: "Other", city: "Town", ...over });
  const participantsFile = (participants, resolutions) => ({ data: { type: "hackarena-participants", version: 2, participants }, ...(resolutions ? { resolutions } : {}) });

  test("every conflict is still found: an address in either slot, in any case, and a split identity; CONTROL: a new person conflicts with nobody", async () => {
    const u = uniq("c").replace(/[^a-z0-9]/gi, "").toLowerCase();
    const a = person(`a${u}`, { secondary_email: `alt-${u}@company.co` });
    const b = person(`b${u}`), c = person(`c${u}`);
    const made = await sa.post("/api/admin/import/participants", { headers: H(saCsrf), data: participantsFile([a, b, c], {}) });
    expect(made.ok(), `seed the accounts: ${made.status()} ${await made.text()}`).toBeTruthy();
    expect((await made.json()).imported, "PRECONDITION: the three accounts exist").toBe(3);
    const idOf = (email) => dbGet("SELECT id FROM users WHERE email=?", email).id;
    const A = idOf(a.email), B = idOf(b.email), C = idOf(c.email);
    expect(dbGet("SELECT secondary_email FROM users WHERE id=?", A).secondary_email, "PRECONDITION: A holds a secondary address").toBe(`alt-${u}@company.co`);

    // One file may not name an address twice (the import refuses it), so each
    // row reaches a different slot of a different account.
    const rows = [
      person(`r0${u}`, { email: a.email.toUpperCase() }),                            // A's primary, another case
      person(`r1${u}`, { email: `ALT-${u}@Company.co` }),                             // A's SECONDARY, as a primary
      person(`r2${u}`, { email: `new2-${u}@company.co`, secondary_email: c.email }), // C's primary, as a secondary
      person(`r3${u}`, { nickname: a.nickname, email: b.email }),                     // A by nickname, B by address
      person(`r4${u}`, { email: `new4-${u}@company.co` }),                            // nobody
    ];
    const dry = await sa.post("/api/admin/import/participants", { headers: H(saCsrf), data: participantsFile(rows) });
    const d = await dry.json();
    expect(dry.status(), JSON.stringify(d)).toBe(200);
    expect(d.dryRun).toBe(true);
    const got = Object.fromEntries(d.conflicts.map(x => [x.index, { type: x.conflictType, id: x.existingId }]));
    expect(got).toEqual({
      0: { type: "email", id: A },
      1: { type: "email", id: A },
      2: { type: "secondary_email", id: C },
      3: { type: "split_identity", id: null },
    });
  });

  test("source: the conflict scan asks the indexed lookup, never the scanning LOWER() form", () => {
    const src = stripJsComments(fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8"));
    const start = src.indexOf('app.post("/api/admin/import/participants"');
    expect(start, "anti-vacuity: the participant import route is found").toBeGreaterThan(0);
    const end = src.indexOf("\n});", start);
    const route = src.slice(start, end);
    expect(route.length, "anti-vacuity: the whole handler").toBeGreaterThan(20_000);
    const dry = route.indexOf("dryRun: true");
    expect(dry, "anti-vacuity: the dry run's answer is in the handler").toBeGreaterThan(0);
    // The conflicts the dry run returns are found by lib/account-lookup.js.
    expect(route.slice(0, dry), "the conflict scan uses findUserByAddress").toMatch(/\bfindUserByAddress\(\s*db\s*,/);
    expect(route, "no lookup in the handler spells the scanning form").not.toMatch(/LOWER\(\s*(?:secondary_)?email\s*\)/i);
  });
});
