// @ts-check
/**
 * v8.3.17 — the external-audit batch.
 *
 * Covers the findings that were CONFIRMED and fixed:
 *   F1  CxOne identity matching + group truth   (lib/cxone-identity.js)
 *   F2  participant CSV formula neutralisation  (public/js/ui/csv.js)
 *   F4  challenge-import field caps             (lib/task-fields.js)
 *   F6  tag DELETE double-decode                (three routes)
 *
 * F5 (partial-import reporting), F7 (temp-ZIP leaks), F8 (loader errors) and F9
 * (duplicate class attributes) are locked where they live — F9 by the source
 * scanner in functional-core-b, the rest by the assertions further down or by
 * existing suites.
 */
const { test, expect } = require("./isolated-test");
const { apiLogin, TEST_DB_PATH } = require("./helpers");
const Database = require("better-sqlite3");

const H = (csrf) => ({ "x-csrf-token": csrf, "content-type": "application/json" });

// ═══════════════════════════════════════════════════════════════════════════
// F1 — CxOne identity matching
// ═══════════════════════════════════════════════════════════════════════════
//
// A PURE module, so the whole matrix is asserted at module scope. That is the
// point of extracting it: the existing CxOne lock is SOURCE-only because the
// outbound-host allowlist refuses a localhost IDP, so nothing behavioural could
// reach this decision through the server. (v8.12.6 — a spawned child with a
// stubbed transport now does, tests/cxone-provision-harness.cjs.)
test.describe("v8.3.17 (F1) — a CxOne account is matched on proof, not on a nickname", () => {
  const { cxOneMatchQuality, CXONE_ACCEPTABLE_BASES } = require("../lib/cxone-identity");
  const ctx = (over = {}) => ({
    preferredUsername: "alice",
    emails: ["alice@acme.com"],
    hasPriorBinding: false,
    ...over,
  });

  test("THE ATTACK: a username match with a DIFFERENT email is refused", () => {
    // The realm is the customer's live Checkmarx One tenant. `alice` there is an
    // employee; `alice` here is whatever nickname a participant chose — and
    // PUT /api/me lets them choose it.
    const q = cxOneMatchQuality(
      { username: "alice", email: "alice@checkmarx-employee.example" }, ctx());
    expect(q, "a nickname collision is not an identity").toBe("conflict");
    expect(CXONE_ACCEPTABLE_BASES.has(q), "and it must not be usable").toBe(false);
  });

  test("THE ATTACK, second shape: a username match on an account with NO email is refused", () => {
    const q = cxOneMatchQuality({ username: "alice", email: undefined }, ctx());
    expect(q, "nothing corroborates the match").toBe("unverifiable");
    expect(CXONE_ACCEPTABLE_BASES.has(q)).toBe(false);
  });

  // ── POSITIVE CONTROLS ──────────────────────────────────────────────────
  // Without these, every assertion above is equally satisfied by a matcher that
  // refuses EVERYTHING — which would break provisioning outright.
  test("POSITIVE CONTROL: an EMAIL match is accepted, whatever the username", () => {
    const q = cxOneMatchQuality({ username: "alice_2", email: "ALICE@acme.com" }, ctx());
    expect(q, "the address is the identity").toBe("email");
    expect(CXONE_ACCEPTABLE_BASES.has(q)).toBe(true);
  });

  // v8.3.34 — RE-POINTED, not weakened (the v7.21.27 rule). This was the only
  // assertion covering the secondary arm, and its subject moved: a secondary
  // address is still RECOGNISED as this participant's, and is no longer PROOF.
  // `secondary_email` is written straight from PUT /api/me and confirmed by
  // nothing, so treating it as top-tier proof handed F1's own attack back at
  // the cost of one extra input.
  test("a SECONDARY address is recognised but is NOT proof", () => {
    const q = cxOneMatchQuality(
      { username: "someone-else", email: "alice.alt@acme.com" },
      ctx({ emails: ["alice@acme.com"], assertedEmails: ["alice.alt@acme.com"] }));
    expect(q, "the account IS found and named, so the refusal can say why").toBe("unverified_email");
    expect(CXONE_ACCEPTABLE_BASES.has(q), "but it must never bind").toBe(false);
  });

  test("THE ATTACK, third shape: nickname collision PLUS a claimed address is still refused", () => {
    // The v8.3.17 residue. Set nickname = the victim's realm username AND
    // secondary_email = the victim's realm address, and the username query
    // returns the victim's account with an address `owned` contained — which
    // the pre-v8.3.34 classifier called proof. In a realm using
    // email-as-username this is ONE input, because _nicknameCharsOk is
    // printable ASCII and so admits `@` and `.`.
    const q = cxOneMatchQuality(
      { username: "alice", email: "victim@customer.example" },
      ctx({ emails: ["attacker@acme.com"], assertedEmails: ["victim@customer.example"] }));
    expect(q, "a claimed address does not corroborate a nickname collision").toBe("unverified_email");
    expect(CXONE_ACCEPTABLE_BASES.has(q)).toBe(false);
  });

  test("an UNVERIFIED primary is a claim, not proof", () => {
    // An instant-join account inside its 48h grace has verified=0, so its
    // primary has never been confirmed either. The call site puts it in
    // `assertedEmails` for exactly this reason.
    const q = cxOneMatchQuality(
      { username: "someone-else", email: "alice@acme.com" },
      ctx({ emails: [], assertedEmails: ["alice@acme.com"] }));
    expect(q).toBe("unverified_email");
    expect(CXONE_ACCEPTABLE_BASES.has(q)).toBe(false);
  });

  test("POSITIVE CONTROL: a prior binding still outranks a claimed address", () => {
    // Without this, the three refusals above are equally satisfied by a matcher
    // that refuses everything with an asserted address in scope — which would
    // break the username-stability feature for every renamed participant.
    const q = cxOneMatchQuality(
      { username: "alice", email: "alice.alt@acme.com" },
      ctx({ emails: ["alice@acme.com"], assertedEmails: ["alice.alt@acme.com"], hasPriorBinding: true }));
    expect(q, "this platform issued that username itself").toBe("prior_binding");
    expect(CXONE_ACCEPTABLE_BASES.has(q)).toBe(true);
  });

  test("POSITIVE CONTROL: OUR OWN prior binding makes the username proof", () => {
    // The username-stability feature: the participant changed their Hack Arena
    // email, so CxOne still holds the old one. Requiring an email match "full
    // stop" would refuse them — this arm is what buys that back.
    const q = cxOneMatchQuality(
      { username: "alice", email: "old-address@acme.com" }, ctx({ hasPriorBinding: true }));
    expect(q).toBe("prior_binding");
    expect(CXONE_ACCEPTABLE_BASES.has(q)).toBe(true);
  });

  test("an unrelated account is not a match at all", () => {
    expect(cxOneMatchQuality({ username: "bob", email: "bob@acme.com" }, ctx())).toBeNull();
    expect(cxOneMatchQuality(null, ctx())).toBeNull();
  });

  test("the ACCEPTABLE set is exactly the two proven bases", () => {
    // An anti-vacuity floor: if a future edit widens this set, every refusal
    // assertion above silently stops meaning anything.
    expect([...CXONE_ACCEPTABLE_BASES].sort()).toEqual(["email", "prior_binding"]);
  });

  test("the shipped provisioning path uses the classifier and searches EXACTly", () => {
    // Source-pinned: the identity decision cannot be driven end to end (the
    // outbound-host allowlist refuses a localhost IDP), so this asserts the wiring
    // that connects the matrix above to production.
    const fs = require("fs"), path = require("path");
    const src = fs.readFileSync(path.join(__dirname, "..", "lib", "cxone.js"), "utf8");
    expect(src, "the classifier is the decision").toMatch(/cxOneMatchQuality\(/);
    expect(src, "and only its ACCEPTABLE bases are used").toMatch(/CXONE_ACCEPTABLE_BASES\.has\(/);
    expect(src, "the old `username-or-email` predicate must not come back")
      .not.toMatch(/u\.username\?\.toLowerCase\(\)\s*===\s*preferredUsername\.toLowerCase\(\)\s*\|\|/);
    // Count in CODE only — this fix's own comment says "exact=true" in prose, and
    // a scanner that reads its own explanation is the v7.21.13 trap.
    const code = src.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
    expect(code, "the username search asks for an exact match").toMatch(/username=\$\{encodeURIComponent\(preferredUsername\)\}&exact=true/);
    // v8.3.34 — re-pointed, not weakened. The subject is unchanged (every email
    // query asks for an exact match); the spelling moved when the search grew to
    // cover EVERY address the classifier can recognise, which is the auditor's
    // literal finding: the secondary was recognisable and never queried.
    expect(code, "and so does every email search").toMatch(/email=\$\{encodeURIComponent\(a\)\}&exact=true/);
    expect(code, "the search covers every address the classifier may see, not just the primary")
      .toMatch(/_searchAddrs/);
    // And the proof SPLIT is wired through: passing one flat list again is what
    // re-opens the v8.3.17 attack at the cost of one extra guessable input.
    expect(code, "proven and asserted addresses reach the classifier separately")
      .toMatch(/emails:\s*provenEmails,\s*assertedEmails/);
    expect(code, "and proof is the VERIFIED column, not mere ownership")
      .toMatch(/_primaryProven\s*=\s*!!\(_emailRow\s*&&\s*_emailRow\.verified\)/);
  });

  test("a configured group that was NOT found is not recorded as an unqualified success", () => {
    const fs = require("fs"), path = require("path");
    const src = fs.readFileSync(path.join(__dirname, "..", "lib", "cxone.js"), "utf8");
    // The discriminator is emitted only when a group was configured, so every
    // historical row and every no-group deployment keeps its exact shape.
    expect(src).toMatch(/group_assigned:\s*!!groupAssigned/);
    expect(src, "and only alongside the name, so the record is actionable").toMatch(/group_name:\s*groupRequested/);
    // And it must have a human consumer — a field nothing renders is the v7.21.2 defect.
    const hist = fs.readFileSync(path.join(__dirname, "..", "public", "js", "features", "history.js"), "utf8");
    expect(hist, "the History dialog reports the missing group").toMatch(/group_assigned===false/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// F2 — participant CSV formula neutralisation
// ═══════════════════════════════════════════════════════════════════════════
test.describe("v8.3.17 (F2) — the participant CSV neutralises formulas, except Phone", () => {
  test("every trigger is neutralised, and the exempt column is byte-identical", () => {
    // The client CSV helper is a browser ESM module; import it the same way the
    // repo's other pure-module unit tests do.
    const fs = require("fs"), path = require("path");
    const src = fs.readFileSync(path.join(__dirname, "..", "public", "js", "ui", "csv.js"), "utf8");
    // Strip the ESM keywords so it can be evaluated in CommonJS.
    //
    // v8.8.15 — IMPORT LINES ARE STRIPPED TOO, and that is not tidiness: this
    // harness silently depended on csv.js having no imports at all, so the day
    // it gained one (`downloadBlob`, when the four download implementations were
    // consolidated) `new Function` threw a SyntaxError and this test failed for
    // a reason with nothing to do with its subject. The three functions asserted
    // below are pure and touch no import, so dropping the line is sound — but
    // anything this file adds that DOES use an import will fail loudly here
    // rather than silently, which is the right direction.
    const mod = { exports: {} };
    // eslint-disable-next-line no-new-func
    new Function("module", "exports",
      src.replace(/^import[^;]*;\s*$/gm, "").replace(/^export\s+/gm, "") +
      "\nmodule.exports={csvCell,toCsv,neutraliseFormula};")(mod, mod.exports);
    const { toCsv } = mod.exports;

    const headers = ["Nickname", "Company", "Phone", "Denial Reason"];
    const rows = [["=cmd|'/c calc'!A1", "+SUM(A1:A9)", "+972-50-1234567", "-1+1"]];
    const out = toCsv(headers, rows, { exemptColumns: ["Phone"] });
    const cells = out.split("\n")[1].split('","').map((s) => s.replace(/^"|"$/g, ""));

    expect(cells[0], "a participant-controlled nickname must not open as a formula").toBe("'=cmd|'/c calc'!A1");
    expect(cells[1], "nor company").toBe("'+SUM(A1:A9)");
    expect(cells[3], "nor a leading minus").toBe("'-1+1");
    // THE OPERATOR'S CONCERN, PRESERVED EXACTLY. v7.24.0 turned neutralisation
    // off for the WHOLE table to protect this one column; the exemption is what
    // lets everything else be guarded without changing these bytes.
    expect(cells[2], "the phone column is byte-identical to what shipped").toBe("+972-50-1234567");

    // THE EXEMPTION IS FOR A NUMBER, NOT FOR THE COLUMN: a participant types
    // their own phone, so a formula there is neutralised like any other cell.
    for (const [phone, want] of [
      ['=HYPERLINK("http://evil.example","call me")', `'=HYPERLINK(""http://evil.example"",""call me"")`],
      ["+SUM(A1:A9)", "'+SUM(A1:A9)"],
      ["@cmd", "'@cmd"],
      ["+1 (555) 123-4567", "+1 (555) 123-4567"],   // CONTROL: a plain number stays raw
    ]) {
      const line = toCsv(["Phone"], [[phone]], { exemptColumns: ["Phone"] }).split("\n")[1];
      expect(line, `phone ${JSON.stringify(phone)}`).toBe(`"${want}"`);
    }
  });

  test("the participants export opts out for Phone ONLY, not for the whole table", () => {
    const fs = require("fs"), path = require("path");
    const src = fs.readFileSync(path.join(__dirname, "..", "public", "js", "features", "export-import.js"), "utf8");
    expect(src, "the blanket opt-out must not come back")
      .not.toMatch(/downloadCsv\('participants\.csv'[^)]*neutralise:\s*false/);
    expect(src).toMatch(/exemptColumns:\s*\['Phone'\]/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// F4 — challenge-import field caps
// ═══════════════════════════════════════════════════════════════════════════
test.describe("v8.3.17 (F4) — the challenge import obeys the same caps as the edit form", () => {
  test("an over-long title is CLAMPED, counted, and the row is still imported", async () => {
    const { api, csrf } = await apiLogin("superadmin");
    const stamp = Date.now();
    const longTitle = "T".repeat(5000) + stamp;
    try {
      const r = await api.post("/api/admin/import/tasks", {
        headers: H(csrf),
        data: {
          data: { type: "hackarena-tasks", tasks: [{
            title: longTitle, description: "<p>x</p>", difficulty: "easy",
            answer_type: "text", correct_answer: "a", status: "draft",
          }] },
          resolutions: {},
        },
      });
      expect(r.status(), `import: ${await r.text()}`).toBe(200);
      const d = await r.json();
      expect(d.imported, "a too-long field must not sink the row — clamping is this handler's idiom").toBe(1);
      // THE COUNT REACHES THE OPERATOR. A silent clamp is the v7.21.2 defect.
      expect(d.fields_truncated, "the clamp is reported").toBeGreaterThan(0);

      const db = new Database(TEST_DB_PATH, { readonly: true });
      try {
        const row = db.prepare("SELECT id, title FROM tasks WHERE title LIKE ?").get("T".repeat(50) + "%");
        expect(row, "the challenge was imported").toBeTruthy();
        expect(row.title.length, "stored at the platform's own cap, not at 5000").toBe(300);
      } finally { db.close(); }
    } finally { await api.dispose(); }
  });

  test("POSITIVE CONTROL: an ordinary title is stored untouched and reports no truncation", async () => {
    const { api, csrf } = await apiLogin("superadmin");
    const title = `Import Cap Control ${Date.now()}`;
    try {
      const r = await api.post("/api/admin/import/tasks", {
        headers: H(csrf),
        data: {
          data: { type: "hackarena-tasks", tasks: [{
            title, description: "<p>x</p>", difficulty: "easy",
            answer_type: "text", correct_answer: "a", status: "draft",
          }] },
          resolutions: {},
        },
      });
      expect(r.status()).toBe(200);
      const d = await r.json();
      expect(d.imported).toBe(1);
      expect(d.fields_truncated || 0, "nothing was clamped").toBe(0);
      const db = new Database(TEST_DB_PATH, { readonly: true });
      try {
        expect(db.prepare("SELECT title FROM tasks WHERE title=?").get(title).title).toBe(title);
      } finally { db.close(); }
    } finally { await api.dispose(); }
  });

  test("tasks.title is indexed, so the conflict scan is not a table scan per row", () => {
    const db = new Database(TEST_DB_PATH, { readonly: true });
    try {
      const idx = db.prepare(
        "SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='tasks' AND name='idx_tasks_title'"
      ).get();
      expect(idx, "idx_tasks_title must exist on a FIRST boot (v8.3.11's lesson: an index created above its column fails silently and is not retried until the next restart)").toBeTruthy();
      // And the planner must actually use it for the importer's lookup.
      const plan = db.prepare("EXPLAIN QUERY PLAN SELECT id, title, locked FROM tasks WHERE title=?").all("probe")
        .map((r) => r.detail).join(" ");
      expect(plan, `the conflict scan must use the index, got: ${plan}`).toMatch(/idx_tasks_title/);
    } finally { db.close(); }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// F6 — the tag DELETE double-decode
// ═══════════════════════════════════════════════════════════════════════════
//
// `req.params` is ALREADY decoded by Express. Decoding again is a second, wrong
// transformation with two measured consequences, and BOTH are asserted because
// they fail in opposite directions: one is a 500, the other is a silent success
// that deletes the wrong row.
test.describe("v8.3.17 (F6) — a tag is deleted by its own name, exactly once", () => {
  test("a tag containing % can be deleted (it used to 500, permanently)", async () => {
    const { api, csrf } = await apiLogin("superadmin");
    const stamp = Date.now();
    let compId;
    try {
      compId = (await (await api.post("/api/admin/competitions", { headers: H(csrf), data: {
        name: `TagPct ${stamp}`, start_time: new Date(stamp + 3600_000).toISOString(), duration_minutes: 60,
      }})).json()).competition.id;

      const add = await api.post(`/api/admin/competitions/${compId}/tags`, { headers: H(csrf), data: { tag: "50% done" } });
      expect(add.status(), "a % tag is creatable — tags are free text ≤50").toBe(200);
      expect((await add.json()).tags).toContain("50% done");

      const del = await api.delete(
        `/api/admin/competitions/${compId}/tags/${encodeURIComponent("50% done")}`,
        { headers: { "x-csrf-token": csrf } });
      expect(del.status(), "the second decode threw URIError → 500, so this tag could never be removed").toBe(200);
      expect((await del.json()).tags, "and it is gone").not.toContain("50% done");
    } finally {
      if (compId) await api.delete(`/api/admin/competitions/${compId}`, { headers: { "x-csrf-token": csrf } });
      await api.dispose();
    }
  });

  test("deleting `%61` removes `%61` and LEAVES `a` alone", async () => {
    // The sharp one: this used to answer 200 having deleted a DIFFERENT tag.
    // Express decodes `%2561` to `%61`; the handler then decoded that to `a`.
    const { api, csrf } = await apiLogin("superadmin");
    const stamp = Date.now();
    let compId;
    try {
      compId = (await (await api.post("/api/admin/competitions", { headers: H(csrf), data: {
        name: `TagEnc ${stamp}`, start_time: new Date(stamp + 3600_000).toISOString(), duration_minutes: 60,
      }})).json()).competition.id;
      for (const tag of ["a", "%61"]) {
        const add = await api.post(`/api/admin/competitions/${compId}/tags`, { headers: H(csrf), data: { tag } });
        expect(add.ok(), `add ${tag}: ${await add.text()}`).toBeTruthy();
      }
      // PRECONDITION (v8.12.4): both tags really landed, or "`%61` is gone" is
      // satisfied by an add that never happened.
      const list = await (await api.get("/api/admin/competitions")).json();
      expect((list.competitions || list).find(c => c.id === compId).tags.slice().sort()).toEqual(["%61", "a"]);

      const del = await api.delete(
        `/api/admin/competitions/${compId}/tags/${encodeURIComponent("%61")}`,
        { headers: { "x-csrf-token": csrf } });
      expect(del.status()).toBe(200);
      const tags = (await del.json()).tags;
      expect(tags, "the tag that was asked for is gone").not.toContain("%61");
      expect(tags, "and the innocent one SURVIVES — this is what used to be deleted instead").toContain("a");
    } finally {
      if (compId) await api.delete(`/api/admin/competitions/${compId}`, { headers: { "x-csrf-token": csrf } });
      await api.dispose();
    }
  });

  test("no tag DELETE handler decodes req.params a second time", () => {
    // The durable half: three handlers carried it, and the next :param route is
    // the one to catch. Scoped to the tag deletes rather than a blanket ban,
    // because lib/util.js's normaliseRoutePath decodes ON PURPOSE (v7.15.17 —
    // the docs gate must normalise the way serve-static does).
    const fs = require("fs"), path = require("path");
    const offenders = [];
    for (const rel of ["routes/competitions.js", "routes/participants.js", "routes/challenges.js"]) {
      const src = fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
      src.split("\n").forEach((line, i) => {
        if (/decodeURIComponent\s*\(\s*req\.params\./.test(line)) offenders.push(`${rel}:${i + 1}`);
      });
    }
    expect(offenders,
      "Express already decoded req.params — a second decode turns `%61` into `a` (wrong row deleted, 200 " +
      "returned) and throws URIError on a literal `%` (500):\n    " + offenders.join("\n    ")
    ).toEqual([]);
  });
});
