// v8.1.0 — PR 13 (Naming B): the kinds reach the client.
//
// PR 11 landed the stored values with NO user-visible label anywhere; PR 12 put
// them on the wire. This PR is the first time a human sees one, and the whole
// design rests on a single asymmetry:
//
//   the SERVER stores an opaque value; the CLIENT renders a label it was GIVEN.
//
// Nothing derives one from the other, and there is no second declaration of the
// table. L1-L4 below are what hold that. L9 is PR 8 debt paid here — it was
// specified for the competitions drift guard, only its FINDINGS were fixed, and
// the mechanical guard was never built; this PR edits both audit enumerations, so
// it is the right place to build it.
const fs = require("fs");
const path = require("path");
const { test, expect } = require("./isolated-test");
const { registerPost } = require("./helpers");
const { freshCtx, getSuperadminPass, TEST_DB_PATH, BASE, PARTICIPANT_PASS, codeLogin } = require("./helpers");
const { adminLogin, clickTab, filterComps } = require("./ui-admin-helpers");

test.use({ baseURL: BASE });

const H = (csrf) => ({ "x-csrf-token": csrf, "content-type": "application/json" });
const TAG = `kn${Date.now().toString(36)}`;
const ROOT = path.join(__dirname, "..");

// The v7.21.24 single-pass stripper. Block-then-line is wrong in one direction: a
// `/*` inside a `//` comment opens a block the stripper closes dozens of lines
// later, deleting real code in between. Whichever comment opens FIRST wins, which
// is the rule a tokeniser applies. Line count is preserved so a hit can name a line.
function stripJsComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, ""));
}
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

function sourceFiles() {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(rel);
      else if (e.name.endsWith(".js")) out.push(rel);
    }
  };
  walk("lib"); walk("routes"); walk("public/js");
  out.push("server.js", "db.js");
  return out;
}

// ── L1 + L3(a) — the vocabulary's own invariants ─────────────────────────────

// v8.1.0 (PR 16) — build a create body that matches the KIND's schedule shape.
// A deadline-shaped kind (program) takes `deadline_at` and refuses
// `duration_minutes`; every other kind is unchanged.
function kindBody(name, kind, startMs, durationMinutes = 60) {
  const start_time = new Date(startMs).toISOString();
  if (kind === "program") {
    return { name, event_kind: kind, start_time, deadline_at: new Date(startMs + durationMinutes * 60_000).toISOString() };
  }
  return { name, event_kind: kind, start_time, duration_minutes: durationMinutes };
}

test.describe("v8.1.0 — L1/L3: the collective is reserved and values are not derived", () => {
  test("L1: no kind label collides with the collective, after normalisation", () => {
    const p = require("../lib/event-policy");
    // Normalised, which the pre-existing exact-match assertion is not: "events"
    // and " Events " must collide too, or the rule is one whitespace slip from
    // being satisfied by a label that reads identically on screen.
    const norm = (s) => String(s).trim().toLowerCase().replace(/\s+/g, " ");
    const reserved = new Set([norm(p.EVENT_COLLECTIVE.singular), norm(p.EVENT_COLLECTIVE.plural)]);
    for (const k of p.EVENT_KINDS) {
      expect(reserved.has(norm(k.label)), `kind label "${k.label}" must not be the collective`).toBe(false);
      expect(reserved.has(norm(k.plural)), `kind plural "${k.plural}" must not be the collective`).toBe(false);
    }
  });

  test("L1b: every kind carries BOTH count nouns, and they are lowercase", () => {
    // Shipping only the singular was a real defect, not an omission: setListCount
    // takes {noun, nounPlural} and an override supplying one leaves the other at
    // the element's dataset value — "3 of 12 events match" on a pane filtered to
    // Programs. Lowercase because countText's zero branch is a full sentence.
    const p = require("../lib/event-policy");
    for (const k of [...p.EVENT_KINDS, p.EVENT_COLLECTIVE]) {
      expect(k.countNoun, `${k.value || "collective"} has a countNoun`).toBeTruthy();
      expect(k.countNounPlural, `${k.value || "collective"} has a countNounPlural`).toBeTruthy();
      expect(k.countNoun).toBe(k.countNoun.toLowerCase());
      expect(k.countNounPlural).toBe(k.countNounPlural.toLowerCase());
    }
  });

  test("L3(b): no SOURCE file computes a stored value from a label", () => {
    // The clause that bites. L3(a) (in event-policy.spec.js) proves only that no
    // whole label EQUALS a stored value — and a first-word derivation
    // ("Booth Event".toLowerCase().split(" ")[0] === "booth") passes it while
    // working for two kinds of three, which is exactly the shape that stays
    // silently correct until it is not.
    //
    // Scoped to SOURCE. tests/event-policy.spec.js legitimately does this very
    // thing to PROVE the labels and values are disjoint, so a scanner covering
    // tests would be wrong about working code — and one that is wrong about
    // working code gets silenced by whoever hits it next.
    const bad = [];
    const re = /\.(label|plural|countNoun|countNounPlural)\.(toLowerCase|toUpperCase|split|replace)\(/;
    for (const rel of sourceFiles()) {
      stripJsComments(read(rel)).split("\n").forEach((line, i) => {
        if (re.test(line)) bad.push(`${rel}:${i + 1}: ${line.trim().slice(0, 100)}`);
      });
    }
    expect(bad, "a stored value must never be derived from a label — the two sets are disjoint ON PURPOSE").toEqual([]);
  });
});

// ── L2 — one declaration, no re-implemented mapping ──────────────────────────
test.describe("v8.1.0 — L2: the label table is declared exactly once", () => {
  test("the shell carries the kind table AND a placeholder the substitution guard tests for", () => {
    // server.js gates the whole substitution on the page holding one of a few
    // placeholders (`includes("{{platformName}}")`, or `{{platformLook}}`, which
    // the help page carries alone), each a deliberately BALANCED literal — a bare
    // `{{` puts two unmatched braces into a string and silently shifts the
    // function boundaries every brace-counting source scanner computes for the
    // rest of the file (it produced three false positives on the v7.21.32
    // reqContext guard before this was understood).
    //
    // That couples the placeholders: if index.html ever carried the kind table
    // WITHOUT one the guard tests for, the guard would skip the page and the SPA
    // would receive the literal "{{eventKinds}}" — the labels silently absent,
    // every chip gone, the create chooser refusing to open. The guard's own list
    // is read from server.js, so a change to it is followed. Locked rather than
    // left as an implicit assumption.
    const html = read("public/index.html");
    expect(html.includes("{{eventKinds}}"), "the shell carries the kind table").toBe(true);
    expect(html.includes("{{eventCollective}}"), "…and the collective").toBe(true);
    const server = stripJsComments(read("server.js"));
    const guards = [...server.matchAll(/rewritten\.includes\("(\{\{\w+\}\})"\)/g)].map((m) => m[1]);
    expect(guards, "anti-vacuity: the substitution guard's placeholders are found in server.js").toContain("{{platformName}}");
    expect(guards.some((g) => html.includes(g)),
      `…and a placeholder the substitution guard tests for (${guards.join(", ")}), or none of them are substituted`).toBe(true);
    expect(/includes\("\{\{"\)/.test(server),
      "the guard must not test a bare `{{` — unmatched braces in a string break brace-counting scanners").toBe(false);
  });

  test("L2(a): EVENT_KINDS / EVENT_COLLECTIVE are declared only in lib/event-policy.js", () => {
    // A literal ban is unbuildable — "Competition" appears dozens of times in
    // public/js, routes and swagger and none of those is the kind label. This
    // forbids an IDENTIFIER instead, following the v7.26.0 "EMAIL_FROM is read in
    // one file" lock.
    const bad = [];
    for (const rel of sourceFiles()) {
      if (rel === "lib/event-policy.js") continue;
      stripJsComments(read(rel)).split("\n").forEach((line, i) => {
        if (/\b(EVENT_KINDS|EVENT_COLLECTIVE)\s*=/.test(line)) bad.push(`${rel}:${i + 1}`);
      });
    }
    expect(bad, "the kind table has exactly one declaration site").toEqual([]);
  });

  test("L2(b): no source file re-implements the kind→label mapping", () => {
    const p = require("../lib/event-policy");
    const labels = p.EVENT_KINDS.flatMap(k => [k.label, k.plural]);
    const values = p.EVENT_KINDS.map(k => k.value);
    const bad = [];
    for (const rel of sourceFiles()) {
      if (rel === "lib/event-policy.js") continue;
      stripJsComments(read(rel)).split("\n").forEach((line, i) => {
        const hasValue = values.some(v => line.includes(`"${v}"`) || line.includes(`'${v}'`));
        const hasLabel = labels.some(l => line.includes(`"${l}"`) || line.includes(`'${l}'`));
        if (hasValue && hasLabel) bad.push(`${rel}:${i + 1}: ${line.trim().slice(0, 110)}`);
      });
    }
    expect(bad, "a stored value quoted beside a label is a second mapping — it will drift").toEqual([]);
  });

  test("L2(c): the client keeps NO fallback kind label", () => {
    // The clause that would silently reintroduce a WRONG answer: `|| 'Competition'`
    // on a Booth Event is not a degraded label, it is the wrong one.
    //
    // NARROWED, because the obvious pattern is wrong about two working lines:
    // participants-admin.js and challenges-admin.js both carry
    // `comp?.name || 'Competition'`, which is a fallback for a missing
    // competition NAME in a dialog title, not for a kind label. So a bare
    // `|| 'Competition'` is only a violation when the line is actually about a
    // kind; the other two labels are unambiguous and need no such qualifier.
    const bad = [];
    const unambiguous = /(\|\||\?\?)\s*['"](Booth Event|Booth Events|Program|Programs)['"]/;
    const ambiguous = /(\|\||\?\?)\s*['"](Competition|Competitions)['"]/;
    const walk = (dir) => {
      for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        const rel = `${dir}/${e.name}`;
        if (e.isDirectory()) { walk(rel); continue; }
        if (!e.name.endsWith(".js")) continue;
        stripJsComments(read(rel)).split("\n").forEach((line, i) => {
          if (unambiguous.test(line) || (ambiguous.test(line) && /kind/i.test(line))) {
            bad.push(`${rel}:${i + 1}: ${line.trim().slice(0, 110)}`);
          }
        });
      }
    };
    walk("public/js");
    expect(bad, "a fallback kind label is a wrong answer, not a degraded one — render nothing instead").toEqual([]);
  });
});

// ── §2.9 — kind-derived refusal copy is {article} {label}, never the value ───
test.describe("v8.1.0 — refusals name the kind in words", () => {
  test("both kind refusals render the LABEL with its own article, never the stored value", async () => {
    const { api, csrf: c0 } = await freshCtx();
    const lr = await api.post("/api/login", { headers: H(c0), data: { email: "superadmin", password: getSuperadminPass() } });
    expect(lr.ok()).toBeTruthy();
    const csrf = (await (await api.get("/api/csrf-token")).json()).csrfToken;
    try {
      const cr = await api.post("/api/admin/competitions", {
        headers: H(csrf),
        data: { name: `${TAG} Refusal`, event_kind: "booth", start_time: new Date(Date.now() + 3600e3).toISOString(), duration_minutes: 60, timezone: "UTC" },
      });
      expect(cr.ok(), `create: ${cr.status()} ${await cr.text()}`).toBeTruthy();
      const comp = (await cr.json()).competition;

      const ts = await api.post(`/api/admin/competitions/${comp.id}/timeslots`, {
        headers: H(csrf), data: { name: "S1", start_time: new Date(Date.now() + 7200e3).toISOString(), duration_minutes: 30, timezone: "UTC" },
      });
      expect(ts.status()).toBe(400);
      const tsErr = (await ts.json()).error;
      expect(tsErr, "the refusal names the kind in words").toContain("a Booth Event");
      expect(tsErr, "and never leaks the stored value into copy").not.toContain("booth\"");
      expect(/\bbooth\b/.test(tsErr), "the stored token must not appear in prose").toBe(false);

      // v8.3.0 — the kind refusal moved from "immutable" to "not once it has
      // started", so the copy is asserted on an event that HAS started. The
      // property under test is unchanged: a kind-derived refusal renders the
      // LABEL with its own article and never the stored token.
      const live = await api.post("/api/admin/competitions", {
        headers: H(csrf),
        data: { name: `${TAG} RefusalLive`, event_kind: "booth", start_time: new Date(Date.now() - 3600e3).toISOString(), duration_minutes: 180, timezone: "UTC" },
      });
      expect(live.ok(), `create live: ${live.status()} ${await live.text()}`).toBeTruthy();
      const liveComp = (await live.json()).competition;
      const put = await api.put(`/api/admin/competitions/${liveComp.id}`, {
        headers: H(csrf), data: { event_kind: "tournament", expectedUpdatedAt: liveComp.updated_at },
      });
      expect(put.status()).toBe(400);
      const putErr = (await put.json()).error;
      expect(/\bbooth\b/.test(putErr), "the refusal never leaks the stored token").toBe(false);
      // And the CHALLENGE-fit refusal, which is the kind-phrased one this change
      // added, still renders the label with its article. v8.12.4 — driven for
      // real: a file-answer challenge on an upcoming Competition, then a switch
      // to Booth Event. The first draft asserted a re-type SUCCEEDED, on an event
      // holding no challenge, so no fit refusal could ever have been produced.
      const retype = await api.put(`/api/admin/competitions/${comp.id}`, {
        headers: H(csrf), data: { event_kind: "tournament", expectedUpdatedAt: comp.updated_at },
      });
      expect(retype.ok(), `an upcoming booth may be re-typed: ${await retype.text()}`).toBeTruthy();
      const asTournament = (await retype.json()).competition;
      const ft = await api.post("/api/admin/tasks", { headers: H(csrf), data: {
        title: `${TAG} Upload`, difficulty: "easy", answer_type: "file", correct_answer: "x", status: "published" } });
      expect(ft.ok(), `file task: ${await ft.text()}`).toBeTruthy();
      const fileTask = (await ft.json()).id;
      const asg = await api.post(`/api/admin/tasks/${fileTask}/competitions`, { headers: H(csrf), data: { competitionIds: [comp.id] } });
      expect(asg.ok(), `assign: ${await asg.text()}`).toBeTruthy();
      const unfit = await api.put(`/api/admin/competitions/${comp.id}`, {
        headers: H(csrf), data: { event_kind: "booth", expectedUpdatedAt: asTournament.updated_at },
      });
      expect(unfit.status(), "a Booth Event cannot hold an upload challenge").toBe(400);
      const fitErr = (await unfit.json()).error;
      expect(fitErr, "the fit refusal names the kind with its article").toContain("a Booth Event");
      expect(/\bbooth\b/.test(fitErr), "and never the stored token").toBe(false);
    } finally { await api.dispose(); }
  });

  test("the article comes from the table, so it cannot be hard-coded against a renamed label", () => {
    // The field exists for the NEXT label, not these three: every current article
    // is "a", so a hard-coded "a" is correct today and silently wrong the first
    // time a kind is called something beginning with a vowel.
    const p = require("../lib/event-policy");
    for (const k of p.EVENT_KINDS) {
      expect(p.eventKindPhrase({ event_kind: k.value })).toBe(`${k.article} ${k.label}`);
    }
    // And no refusal builds the phrase by hand.
    const bad = [];
    for (const rel of sourceFiles()) {
      if (rel === "lib/event-policy.js") continue;
      stripJsComments(read(rel)).split("\n").forEach((line, i) => {
        if (/\b(a|an|A|An)\s+\$\{\s*eventKindLabel\(/.test(line)) bad.push(`${rel}:${i + 1}: ${line.trim().slice(0, 100)}`);
      });
    }
    expect(bad, "use eventKindPhrase — an article hard-coded beside a label is one rename from being wrong").toEqual([]);
  });
});

// ── L4 — labels render, values store, and the field REACHES the surfaces ─────
test.describe("v8.1.0 — L4: labels render, values store", () => {
  test("all four halves: History label, stored value in details, the participant payload, and no label at rest", async () => {
    const { api, csrf: c0 } = await freshCtx();
    const lr = await api.post("/api/login", { headers: H(c0), data: { email: "superadmin", password: getSuperadminPass() } });
    expect(lr.ok(), `superadmin login: ${lr.status()}`).toBeTruthy();
    const csrf = (await (await api.get("/api/csrf-token")).json()).csrfToken;
    try {
      const cr = await api.post("/api/admin/competitions", {
        headers: H(csrf),
        data: {
          name: `${TAG} L4 Booth`, event_kind: "booth",
          start_time: new Date(Date.now() - 3600e3).toISOString(),
          duration_minutes: 600, timezone: "UTC",
        },
      });
      expect(cr.ok(), `create booth: ${cr.status()} ${await cr.text()}`).toBeTruthy();
      const comp = (await cr.json()).competition;

      // (2) The stored value is in the audit details — PRESENCE, not merely "no
      // label string". An earlier draft of this rule was satisfied by the field
      // being absent entirely, which is the state PR 13 exists to fix.
      const evs = await (await api.get(`/api/admin/competitions/${comp.id}/events`)).json();
      const created = (evs.events || evs || []).find(e => e.event_type === "created");
      expect(created, "the created event exists").toBeTruthy();
      const details = typeof created.details === "string" ? JSON.parse(created.details) : created.details;
      expect(details.event_kind, "the created audit records the STORED value").toBe("booth");

      // (4) …and never a label. Audit rows are retained 730 days; a renameable
      // display string frozen into them is a wrong answer two years long.
      const blob = JSON.stringify(details);
      for (const label of ["Booth Event", "Competition", "Program"]) {
        expect(blob.includes(label), `audit details must not carry the label "${label}"`).toBe(false);
      }

      // (3) The participant payload clause — this is what catches a missing
      // _PARTICIPANT_COMP_COLUMNS entry, which would leave the chip painting on
      // login and vanishing when the poll lands.
      //
      // It needs a REAL participant: GET /api/me 401s for the BUILT-IN superadmin
      // by design (no users row), so asserting through the admin session would be
      // asserting on an error body.
      const email = `${TAG}-l4@company.example`;
      const reg = await registerPost(api, "/api/register", {
        headers: H(csrf),
        data: {
          firstName: "Kind", lastName: "Four", nickname: `${TAG}_l4`, email,
          company: "Acme", title: "Engineer", country: "US", timezone: "America/New_York",
          password: PARTICIPANT_PASS, jobFunction: "Software Developer / Engineer", city: "Testville",
        },
      });
      expect(reg.status(), `register: ${await reg.text()}`).toBe(200);
      const list = await (await api.get(`/api/admin/participants?limit=500&search=${encodeURIComponent(email)}`)).json();
      const u = (list.participants || []).find(p => p.email === email);
      expect(u, "the participant is findable").toBeTruthy();
      await api.post(`/api/admin/participants/${u.id}/verify`, { headers: H(csrf) });
      await api.post(`/api/admin/participants/${u.id}/approve`, { headers: H(csrf) });
      const asg = await api.post("/api/admin/competitions/assign", {
        headers: H(csrf), data: { userIds: [String(u.id)], competitionIds: [String(comp.id)] },
      });
      expect(asg.ok(), `assign: ${asg.status()} ${await asg.text()}`).toBeTruthy();
      // The assign endpoint SILENTLY SKIPS ineligible users, so assert the
      // precondition rather than discovering it as an empty payload downstream.
      expect((await asg.json()).assigned, "the participant was really enrolled").toBeGreaterThan(0);

      const pc = await freshCtx();
      try {
        const plogin = await codeLogin(pc.api, email, H(pc.csrf));
        expect(plogin.ok(), `participant login: ${plogin.status()} ${await plogin.text()}`).toBeTruthy();
        const me = await (await pc.api.get("/api/me")).json();
        expect(me.competitions.find(c => c.id === comp.id)?.event_kind,
          "/api/me carries the stored kind").toBe("booth");
        const myComps = await (await pc.api.get("/api/my-competitions")).json();
        expect(myComps.find(c => c.id === comp.id)?.event_kind,
          "/api/my-competitions carries it too — the poll must agree with the first paint").toBe("booth");
      } finally { await pc.api.dispose(); }
    } finally { await api.dispose(); }
  });

  test("L4(1): the History dialog renders the LABEL and the collective container noun", async ({ page }) => {
    const { api, csrf: c0 } = await freshCtx();
    const lr = await api.post("/api/login", { headers: H(c0), data: { email: "superadmin", password: getSuperadminPass() } });
    expect(lr.ok()).toBeTruthy();
    const csrf = (await (await api.get("/api/csrf-token")).json()).csrfToken;
    const name = `${TAG} HistBooth`;
    const cr = await api.post("/api/admin/competitions", {
      headers: H(csrf),
      data: { name, event_kind: "booth", start_time: new Date(Date.now() + 3600e3).toISOString(), duration_minutes: 60, timezone: "UTC" },
    });
    expect(cr.ok(), `create: ${cr.status()} ${await cr.text()}`).toBeTruthy();
    const compId = (await cr.json()).competition.id;
    await api.dispose();

    await adminLogin(page);
    await clickTab(page, "Events");
    // The client renders History from the same details blob asserted above, so
    // drive the renderer directly rather than hunting a kebab in a paginated
    // table — what is under test is the label map, not the menu.
    const rendered = await page.evaluate(async (id) => {
      const r = await fetch(`/api/admin/competitions/${id}/events`);
      const d = await r.json();
      const ev = (d.events || d).find(e => e.event_type === "created");
      return window.formatEventChange(ev);
    }, compId);
    expect(rendered, "History renders the LABEL, never the stored value").toContain("Booth Event");
    expect(rendered, "…and labels the field in words").toContain("Event type");
    expect(/>\s*event_kind\s*:/.test(rendered), "the raw column name is not shown as the field label").toBe(false);
  });
});

// ── L9 — every competitions column is audited, or exempted with a reason ─────
test.describe("v8.1.0 — L9: the audit enumerations cannot drift from the schema", () => {
  // PR 8 debt. The class it guards is pure drift: a column is added, nothing
  // errors, and History quietly stops describing the entity.
  //
  // It demands a DECISION per column, not coverage — self_enroll_token MUST NOT
  // be audited (a 256-bit capability on _REDACT_KEYS) while trusted_network_ips
  // deliberately IS (v7.16.4), so a lock requiring blanket coverage would be
  // wrong about working code.
  const EXEMPT = new Map([
    ["id", "Surrogate key — it IS the entity the event hangs off."],
    ["created_at", "Set once at create; the created event's own timestamp says it."],
    ["updated_at", "Concurrency bookkeeping, rewritten by every write including the audited ones."],
    ["linkedin_signup_enabled", "Retired with LinkedIn sign-in: every row stores 0 and no route writes or reads it, so there is no change to audit."],
    ["self_enroll_allow_instant", "Retired (operator ruling, 14 Nov 2026): create, the PUT and template settings refuse it 400 self_enroll_instant_removed and nothing reads it, so it never changes and there is nothing to audit."],
    ["self_enroll_token", "A 256-bit join capability on _REDACT_KEYS. Auditing it would put a live secret in rows retained 730 days."],
    ["cxone_api_key", "A per-competition credential; the cxone_config_changed event records THAT it changed, never the value."],
    ["ended_at", "Written by the lifecycle paths, which emit their own ended_manually / auto_ended / revived events carrying the reason."],
    ["ended_manually", "As ended_at — the lifecycle events carry it."],

    ["join_code", "Phase 7: a join CAPABILITY, and not settable at the boundary yet."],
    // Audited, but NOT through these two enumerations — each has a dedicated
    // event, so demanding a ladder entry would be wrong about working code.
    // Found by this guard's first run, which is the argument for building it.
    ["cxone_group_name", "Not settable at create (the client saves CxOne in a follow-up call) and edited only via PUT .../cxone, which emits cxone_config_changed{group_name}."],
    ["event_look", "Not settable at create or through the competition PUT; edited only via PUT .../look, which emits look_changed with from and to."],
    ["event_look_locked", "As event_look: written only by PUT .../look, inside the same look_changed event."],
    ["certificate_config", "Not settable at create or through the competition PUT; edited only via PUT/DELETE .../certificate-config, which emits certificate_config_changed with the fields it set."],
    ["trusted_network_ips", "Recorded at create, and on edit by its OWN event — trusted_networks_changed / trusted_networks_applied (v7.21.7), which also carry blocks_released. A `changes` ladder entry would duplicate it."],
  ]);

  test("every competitions column is audited at create AND at edit, or exempted with a reason", () => {
    const src = stripJsComments(read("routes/competitions.js"));

    // The `created` details literal.
    const createdAt = src.indexOf('"created", adminId, {');
    expect(createdAt, "the created audit emit is findable").toBeGreaterThan(-1);
    const createdLiteral = src.slice(createdAt, src.indexOf("\n", createdAt));
    const createdKeys = new Set([...createdLiteral.matchAll(/([a-z_][a-z0-9_]*)\s*:/gi)].map(m => m[1]));

    // The `edited` ladder.
    const editedKeys = new Set([...src.matchAll(/changes\.([a-z_][a-z0-9_]*)\s*=/gi)].map(m => m[1]));

    const Database = require("better-sqlite3");
    const db = new Database(TEST_DB_PATH, { readonly: true });
    let cols;
    try { cols = db.prepare("PRAGMA table_info(competitions)").all().map(c => c.name); }
    finally { db.close(); }
    expect(cols.length, "the table was found").toBeGreaterThan(10);

    const missing = [];
    for (const c of cols) {
      if (EXEMPT.has(c)) continue;
      if (!createdKeys.has(c)) missing.push(`${c} (absent from the CREATED audit literal)`);
      if (!editedKeys.has(c)) missing.push(`${c} (absent from the EDITED ladder)`);
    }
    expect(missing,
      "a new competitions column must be audited at create AND at edit, or added to EXEMPT with the reason it must not be"
    ).toEqual([]);

    // Anti-vacuity: an exemption for a column that no longer exists is stale
    // bookkeeping that would quietly excuse a real gap if the name came back.
    const stale = [...EXEMPT.keys()].filter(c => !cols.includes(c));
    expect(stale, "EXEMPT names a column that no longer exists").toEqual([]);
  });
});

// ── The two surfaces that REFUSE, and the one that renders nothing ───────────
test.describe("v8.1.0 — the kind surfaces", () => {
  test("the filter row, the chip and the create chooser all speak the labels", async ({ page }) => {
    const { api, csrf: c0 } = await freshCtx();
    const lr = await api.post("/api/login", { headers: H(c0), data: { email: "superadmin", password: getSuperadminPass() } });
    expect(lr.ok()).toBeTruthy();
    const csrf = (await (await api.get("/api/csrf-token")).json()).csrfToken;
    const progName = `${TAG} UIProg`;
    for (const [kind, nm] of [["program", progName], ["tournament", `${TAG} UIComp`]]) {
      const r = await api.post("/api/admin/competitions", {
        headers: H(csrf),
        data: { ...kindBody(nm, kind, Date.now() + 3600e3), timezone: "UTC" },
      });
      expect(r.ok(), `create ${kind}: ${r.status()} ${await r.text()}`).toBeTruthy();
    }
    await api.dispose();

    await adminLogin(page);
    await clickTab(page, "Events");

    // The kind filter row is built from the table, so it names the PLURALS.
    const chips = await page.locator("#comp-kind-filters .filter-btn").allTextContents();
    expect(chips, "the filter row teaches all three words plus an All").toEqual(
      ["All types", "Booth Events", "Competitions", "Programs"]);

    // The chip on the row — keyed on the stored value, rendering the label.
    await filterComps(page, progName);
    // filterComps returns as soon as a matching row is visible, and the search is
    // DEBOUNCED — so poll for the narrowed state rather than reading straight
    // through, or this samples the pre-filter table.
    await expect.poll(async () => page.locator("#admin-comp-body tr").count(), { timeout: 5000 }).toBe(1);
    const chip = page.locator("#admin-comp-body tr .kind-chip");
    await expect(chip).toHaveText("Program");
    expect(await chip.getAttribute("data-kind"), "the chip carries the STORED value, renders the label").toBe("program");

    // The New event page: one blank starter per kind, captioned with the wire
    // labels, and the usual one MARKED rather than pre-selected: nothing opens
    // until a starter is picked, so an admin cannot create an event having never
    // read the three words.
    await page.click('[data-action="open-competition-form"]');
    await page.locator('#tpl-kind-cards [data-action="new-event-start"]').first().waitFor({ state: "visible", timeout: 10000 });
    const cards = await page.locator('#tpl-kind-cards [data-action="new-event-start"] .tpl-kind-title').allTextContents();
    expect(cards).toEqual(["Booth Event", "Competition", "Program"]);
    expect(await page.locator('#tpl-kind-cards [data-action="new-event-start"]:has(.tpl-kind-default)').getAttribute("data-kind"),
      "the default is the kind every existing event already is").toBe("tournament");
    expect(await page.locator("#tpl-kind-cards .tpl-kind-default").count(),
      "exactly one starter is marked as the usual answer").toBe(1);
    // And the form's type field carries the same three labels.
    await page.locator('#tpl-kind-cards [data-action="new-event-start"][data-kind="booth"]').click();
    await page.locator("#comp-name").waitFor({ state: "visible", timeout: 10000 });
    expect(await page.locator("#comp-form-overlay .kind-seg-opt span").allTextContents()).toEqual(["Booth Event", "Competition", "Program"]);
  });

  test("with NO vocabulary the chip renders nothing and New event REFUSES to offer starters", async ({ page }) => {
    // The axis, asserted rather than described: a surface renders NOTHING when it
    // merely labels something, and REFUSES when it IS the vocabulary. Three cards
    // captioned booth / tournament / program teach the wrong three words to the
    // one admin trying to learn them.
    await adminLogin(page);
    await clickTab(page, "Events");
    await page.evaluate(() => { window.S.eventKinds = []; });

    expect(await page.evaluate(() => window.eventKindChipHtml("tournament")),
      "the chip renders nothing rather than a wrong or raw label").toBe("");
    expect(await page.evaluate(() => window.eventKindLabel("tournament")),
      "and there is no fallback label anywhere").toBeNull();

    await page.evaluate(() => { window.openCompetitionForm(); });
    await page.locator("#admin-templates-tab").waitFor({ state: "visible", timeout: 10000 });
    await expect(page.locator("#tpl-kind-cards"), "the page says why instead of captioning starters with stored values")
      .toContainText("did not load");
    expect(await page.locator('#tpl-kind-cards [data-action="new-event-start"]').count(),
      "no blank starter is offered").toBe(0);
    // And the form cannot be reached past it either.
    await page.evaluate(() => { window.openCompetitionForm(null, { kind: "tournament" }); });
    await page.waitForTimeout(300);
    expect(await page.locator("#comp-form-overlay").count(),
      "the form refuses to open without the vocabulary").toBe(0);

    // Positive control: with the vocabulary restored it opens. Without this,
    // "the form did not open" is equally satisfied by a form that never opens.
    await page.reload();
    await page.waitForSelector("#admin-page.active", { timeout: 15000 });
    await clickTab(page, "Events");
    await page.evaluate(() => { window.openCompetitionForm(); });
    await page.locator('#tpl-kind-cards [data-action="new-event-start"]').first().waitFor({ state: "visible", timeout: 10000 });
    expect(await page.locator('#tpl-kind-cards [data-action="new-event-start"]').count()).toBe(3);
  });
});
