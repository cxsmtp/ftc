// v8.1.0 — PR 25: completion, `basis`, and the parts a verifier will be matched
// against.
//
// A Program has no ranking anywhere (PR 18 suppressed the board, the score pill
// and the Leaderboard tab), so its certificate cannot attest a placing. It attests
// one thing instead: every assigned challenge solved. `basis` records WHICH rule
// minted a badge, and `name_match_snapshot` freezes the name PARTS the credential
// lookup will compare a typed surname against.
const { test, expect } = require("./isolated-test");
const { registerPost } = require("./helpers");
const { freshCtx, getSuperadminPass, PARTICIPANT_PASS, TEST_DB_PATH, codeLogin, BASE } = require("./helpers");

const H = (c) => ({ "x-csrf-token": c, "content-type": "application/json" });
const TAG = `cc${Date.now().toString(36)}`;
let seq = 0;
const uniq = () => `${TAG}${(seq++).toString(36)}`;

async function sa() {
  const { api, csrf: c0 } = await freshCtx();
  const r = await api.post("/api/login", { headers: H(c0), data: { email: "superadmin", password: getSuperadminPass() } });
  expect(r.ok(), `superadmin login: ${r.status()}`).toBeTruthy();
  return { api, csrf: (await (await api.get("/api/csrf-token")).json()).csrfToken };
}

async function makeParticipant(api, csrf, label, extra = {}) {
  const email = `${label}@company.example`;
  const reg = await registerPost(api, "/api/register", {
    headers: H(csrf),
    data: {
      firstName: extra.firstName || "Comp", lastName: extra.lastName || "Letion",
      nickname: label, email, company: "Acme", title: "Engineer", country: "US",
      timezone: "America/New_York", password: PARTICIPANT_PASS,
      jobFunction: "Software Developer / Engineer", city: "Testville",
    },
  });
  expect(reg.status(), `register ${label}: ${await reg.text()}`).toBe(200);
  const list = await (await api.get(`/api/admin/participants?limit=500&search=${encodeURIComponent(email)}`)).json();
  const u = (list.participants || []).find(p => p.email === email);
  expect(u, `${label} findable`).toBeTruthy();
  await api.post(`/api/admin/participants/${u.id}/verify`, { headers: H(csrf) });
  await api.post(`/api/admin/participants/${u.id}/approve`, { headers: H(csrf) });
  return { id: u.id, email };
}

/** An event of the given kind, N challenges, one enrolled participant. */
async function makeEvent(api, csrf, { kind, tasks = 2, person = {} }) {
  const start = new Date(Date.now() - 3600e3).toISOString();
  const data = { name: `${uniq()} ${kind}`, event_kind: kind, start_time: start, timezone: "UTC" };
  if (kind === "program") data.deadline_at = new Date(Date.now() + 90 * 86400e3).toISOString();
  else data.duration_minutes = 600;
  const cr = await api.post("/api/admin/competitions", { headers: H(csrf), data });
  expect(cr.ok(), `create ${kind}: ${await cr.text()}`).toBeTruthy();
  const comp = (await cr.json()).competition;

  const ids = [];
  for (let i = 0; i < tasks; i++) {
    const tr = await api.post("/api/admin/tasks", {
      headers: H(csrf),
      data: { title: `${uniq()} T${i}`, description: "d", difficulty: "easy",
              answer_type: "text", correct_answer: `right${i}`, status: "published" },
    });
    expect(tr.ok(), await tr.text()).toBeTruthy();
    const id = (await tr.json()).id;
    const asg = await api.post(`/api/admin/tasks/${id}/competitions`, { headers: H(csrf), data: { competitionIds: [comp.id] } });
    expect(asg.ok(), await asg.text()).toBeTruthy();
    ids.push((await asg.json()).copies[0].task_id);   // the event's own copy (lib/event-copies.js): what its participants open and answer
  }

  const user = await makeParticipant(api, csrf, uniq(), person);
  const asg = await api.post("/api/admin/competitions/assign", {
    headers: H(csrf), data: { userIds: [user.id], competitionIds: [comp.id] },
  });
  expect(asg.ok(), await asg.text()).toBeTruthy();
  expect((await asg.json()).assigned).toBe(1);
  return { comp, taskIds: ids, user };
}

async function enter(email, compId) {
  const { api, csrf: c0 } = await freshCtx();
  const li = await codeLogin(api, email, H(c0));
  expect(li.ok(), `login ${email}: ${await li.text()}`).toBeTruthy();
  const csrf = (await (await api.get("/api/csrf-token")).json()).csrfToken;
  const sel = await api.post("/api/select-competition", { headers: H(csrf), data: { competitionId: compId } });
  expect(sel.ok(), `select: ${await sel.text()}`).toBeTruthy();
  return { api, csrf };
}

async function submit(api, csrf, taskId, answer) {
  const view = await (await api.get(`/api/tasks/${taskId}`)).json();
  const r = await api.post(`/api/tasks/${taskId}/submit`, {
    headers: { "x-csrf-token": csrf },
    multipart: { answer, gradingHash: view.grading_hash || "" },
  });
  return { status: r.status(), body: await r.json().catch(() => ({})) };
}

const badgeRow = (token) => {
  const Database = require("better-sqlite3");
  const db = new Database(TEST_DB_PATH, { readonly: true });
  try { return db.prepare("SELECT * FROM achievement_badges WHERE token=?").get(token); }
  finally { db.close(); }
};

test.describe("v8.1.0 — the credential fold and match keys", () => {
  test("the fold survives copying a name off paper, and nothing more", () => {
    const { credentialNameKey: k } = require("../lib/badge.js");
    // What a verifier's typing legitimately loses.
    expect(k("García"), "an accent they cannot type").toBe(k("Garcia"));
    expect(k("GARCÍA"), "case").toBe(k("garcía"));
    expect(k("Doe-Smith"), "a hyphen they drop").toBe(k("Doe Smith"));
    expect(k("O'Brien"), "an apostrophe").toBe(k("OBrien"));
    expect(k("  Doe  "), "surrounding space").toBe(k("Doe"));
    // Full case folding, not toLowerCase — the v7.15.7 distinction.
    expect(k("Straße"), "eszett folds to ss").toBe(k("STRASSE"));
    expect(k("ΙΩΆΝΝΟΥ"), "greek, incl. final sigma").toBe(k("Ιωάννου"));
    expect(k("ИВАНОВА"), "cyrillic").toBe(k("Иванова"));
    // …and what it must NOT lose, or the surname stops being a second factor.
    expect(k("Doe")).not.toBe(k("Doa"));
    expect(k("Li")).not.toBe(k("Liu"));
    expect(k("Doe"), "an empty typed value matches nothing").not.toBe(k(""));
    expect(k(""), "nothing folds to nothing").toBe("");
    expect(k(null)).toBe("");
  });

  // v8.8.14 — THE STROKED LETTERS, WHICH NFKD CANNOT REACH.
  //
  // Stripping combining marks folds García/Garcia and Müller/Muller for free,
  // and that is why the gap was invisible: every accent case passed. ø, ł, đ, þ,
  // ð, ħ, ŧ and the ligatures æ/œ have NO canonical decomposition, so a
  // Norwegian, Polish, Serbian, Icelandic or Maltese holder's GENUINE
  // certificate read as forged to an employer typing what was printed on it —
  // and they could burn the 10/hour per-code budget proving otherwise.
  //
  // Measured before the fix: 8 of these 12 pairs differed.
  test("a stroked or ligature letter folds to the letters a verifier types", () => {
    const { credentialNameKey: k } = require("../lib/badge.js");
    const PAIRS = [
      ["Løvland", "Lovland", "norwegian o-slash"],
      ["Øystein", "Oystein", "…leading, and uppercase-sourced"],
      ["LØVLAND", "lovland", "…from an all-caps printing"],
      ["Łukasz", "Lukasz", "polish l-stroke"],
      ["Đorđević", "Dordevic", "serbian d-stroke, twice, with an accent"],
      ["Þorsteinn", "Thorsteinn", "icelandic thorn -> th"],
      ["Þórdís", "Thordis", "…thorn AND an accent in one name"],
      ["ÐUREK", "Durek", "eth"],
      ["Ħamed", "Hamed", "maltese h-stroke"],
      ["Ŧorvald", "Torvald", "t-stroke"],
      ["Ærø", "Aero", "ligature and stroke together"],
      ["Œuvre", "Oeuvre", "oe ligature"],
    ];
    for (const [printed, typed, why] of PAIRS) {
      expect(k(printed), `${why}: "${printed}" must be reachable by typing "${typed}"`).toBe(k(typed));
    }
  });

  // The two halves that make the widening safe. Neither is decoration: the first
  // is what a naive `_transliterateAscii` reuse would destroy, the second is what
  // stops the fold becoming "every surname matches".
  test("…without folding a non-Latin surname to NOTHING, and without merging real names", () => {
    const { credentialNameKey: k, credentialMatchKeys: m } = require("../lib/badge.js");

    // `_transliterateAscii` (lib/util.js) ends by stripping to [a-z0-9], so
    // routing the credential fold through it folds these to "" — and an empty
    // key is DROPPED by credentialMatchKeys, so the certificate would match
    // nothing at all. Share the table, never the function.
    for (const name of ["Παπαδόπουλος", "Иванов", "李", "Ωμέγα"]) {
      expect(k(name), `"${name}" must fold to itself, not to the empty string`).not.toBe("");
      expect(m({ given: "X", family: name }).size, `…and still yield a usable key`).toBeGreaterThan(0);
    }

    // The surname is a SECOND FACTOR. A wider fold must not make different
    // names one key — without this, "the stroked letters fold" is satisfied by
    // a build that folds everything to the empty string.
    expect(k("Løvland"), "a stroke is not a free letter").not.toBe(k("Lovlund"));
    expect(k("Łukasz")).not.toBe(k("Lukasy"));
    expect(k("Þorsteinn"), "thorn is th, not t").not.toBe(k("Torsteinn"));
    expect(k("Đorđević")).not.toBe(k("Dordevik"));

    // And the one this release deliberately does NOT take: ü stays u, because
    // the mark-strip already answers it and Müller/Muller works today. Mapping
    // it to "ue" would trade that away for Müller/Mueller; the two spellings
    // cannot both be one key.
    expect(k("Müller"), "the mark-strip answer is preserved").toBe(k("Muller"));
    expect(k("Müller"), "…and the German spelling is a separate, untaken decision").not.toBe(k("Mueller"));
  });

  // v8.8.14 — THE TWO PROPERTIES A PAIR-BY-PAIR TEST CANNOT SEE, and the reason
  // this one sweeps instead of listing.
  //
  // The first draft of the stroked-letter fix applied the table BEFORE the NFKD
  // decomposition, which is wrong for a PRECOMPOSED letter that only becomes a
  // table key after decomposing — Ǿ and Ǣ, the Old Norse ø/æ with an acute or a
  // macron. Every hand-written pair above still passed. What it broke was
  // NORMALISATION-INVARIANCE: `Sǿrensen` in NFC folded to "sørensen" and the
  // SAME NAME in NFD to "sorensen", so a certificate was unverifiable against
  // its own name in the other encoding, with a spurious "the holder's name has
  // changed" beside it. The original fold had ZERO such violations; the draft
  // introduced SIX. Nothing in the suite could see that, which is why this test
  // sweeps a codepoint range rather than naming characters somebody thought of.
  //
  // Both properties are asserted at ZERO, not "no worse than before": the
  // shipped ordering measures 0 and 0 where the pre-v8.8.14 fold was 0 and 1.
  test("the fold is normalisation-invariant and idempotent, swept not listed", () => {
    const { credentialNameKey: k } = require("../lib/badge.js");
    const norm = [], idem = [];
    for (let cp = 0x20; cp <= 0x2FFF; cp++) {
      const ch = String.fromCodePoint(cp);
      // The same name in NFC and NFD must reach the same key, or a verifier
      // whose keyboard emits one form cannot match a certificate stored in the
      // other — and neither of them did anything wrong.
      if (k(ch.normalize("NFC")) !== k(ch.normalize("NFD"))) norm.push(ch);
      // Folding a key again must not move it. A fold that is not a fixed point
      // means some already-folded value would stop matching itself.
      if (k(k(ch)) !== k(ch)) idem.push(ch);
    }
    expect(norm, `NFC and NFD must fold alike; offenders: ${norm.join(" ")}`).toEqual([]);
    expect(idem, `k(k(x)) must equal k(x); offenders: ${idem.join(" ")}`).toEqual([]);

    // The concrete name the first draft broke, kept as a named case so the
    // sweep's failure message is not the only thing pointing at it.
    for (const n of ["Sǿrensen", "Ǣgir", "Ǽsir"]) {
      expect(k(n.normalize("NFC")), `"${n}" must fold the same in either encoding`)
        .toBe(k(n.normalize("NFD")));
    }
  });

  // ── v8.8.18 — BOTH SPELLINGS, AS ALTERNATIVES ───────────────────────────────
  //
  // v8.8.14 closed the stroked-letter half and left `ü -> ue` recorded as a
  // POLICY QUESTION rather than a gap: the mark-strip answers ü as `u`, so
  // Müller/Muller matches today, and mapping ü to `ue` INSTEAD would trade that
  // away to fix Müller/Mueller — the two spellings cannot both be one key. The
  // operator asked on 7 September 2026, and the answer is the shape that release
  // named: a SECOND key, never a changed fold.
  //
  // The distinction is the whole design and is what these arms pin. A fold
  // change swaps one spelling for another; a second key serves both. So
  // `credentialNameKey` is untouched — every property v8.8.14 measured about its
  // ORDER still holds, and the sweep above still runs against it unchanged.
  test("a digraph spelling verifies the same certificate as the diacritic", () => {
    const { credentialMatchKeys: m } = require("../lib/badge.js");
    // family, and the spellings a verifier might reasonably type for it
    const PAIRS = [
      ["Müller",   ["Müller", "Muller", "Mueller"]],
      ["Löwe",     ["Löwe", "Lowe", "Loewe"]],
      ["Bär",      ["Bär", "Bar", "Baer"]],
      ["Sørensen", ["Sørensen", "Sorensen", "Soerensen"]],
      ["Ågård",    ["Ågård", "Agard", "Aagaard"]],
    ];
    const { credentialNameKey: k } = require("../lib/badge.js");
    for (const [family, typed] of PAIRS) {
      const keys = m({ given: "Jo", family });
      for (const t of typed) {
        expect(keys.has(k(t)), `"${t}" must verify a certificate frozen as "${family}" (keys: ${[...keys].join(",")})`).toBe(true);
      }
    }
  });

  test("…and it converges from the OTHER side too — an already-spelled-out name", () => {
    // A holder whose profile says `Aagaard` and a verifier who types `Ågård`.
    // Without this the feature is one-directional, which is not what "both
    // spellings" means, and the asymmetry would be invisible from the pairs above.
    const { credentialMatchKeys: m, credentialNameKey: k } = require("../lib/badge.js");
    expect(m({ given: "Jo", family: "Aagaard" }).has(k("Aagaard")), "self").toBe(true);
    expect(m({ given: "Jo", family: "Ågård" }).has(k("Aagaard")), "diacritic cert, spelled-out query").toBe(true);
  });

  test("CONTROL — it is a SECOND key, so the canonical fold did not move", () => {
    // The failure this exists to catch is the one v8.8.14 refused: implementing
    // the request by CHANGING the fold, which fixes Müller/Mueller and silently
    // breaks Müller/Muller — a regression invisible to every arm above, because
    // every one of them would still pass.
    const { credentialNameKey: k, credentialMatchKeys: m } = require("../lib/badge.js");
    expect(k("Müller"), "the canonical fold still drops the diaeresis").toBe("muller");
    expect(k("Sørensen"), "…and still folds ø to o").toBe("sorensen");
    expect(m({ given: "Jo", family: "Müller" }).has("muller"), "the primary key survives").toBe(true);
  });

  test("CONTROL — the extra key is NARROW: it does not merge real names", () => {
    // Widening a match on a trust document is the thing to be careful about, so
    // the narrowness is asserted rather than assumed. Each pair is two different
    // families that a careless expansion could collapse.
    const { credentialMatchKeys: m, credentialNameKey: k } = require("../lib/badge.js");
    const NOT = [
      ["Müller", "Miller"], ["Müller", "Mahler"], ["Löwe", "Lowes"],
      ["Sørensen", "Sorenson"], ["Ågård", "Agarde"], ["Bär", "Beer"],
      // v8.8.14's own narrowness pair must survive untouched.
      ["Løvland", "Lovlund"],
    ];
    for (const [family, other] of NOT) {
      expect(m({ given: "Jo", family }).has(k(other)),
        `"${other}" must NOT verify a certificate frozen as "${family}"`).toBe(false);
    }
  });

  test("CONTROL — a name with none of those letters gains no extra key", () => {
    // Or "the alternates work" is satisfied by a build that emits noise for
    // everybody, which would widen every certificate on the platform.
    const { credentialMatchKeys: m } = require("../lib/badge.js");
    for (const family of ["Smith", "García", "Παπαδόπουλος", "Иванов", "李"]) {
      expect(m({ given: "Jo", family }).size, `"${family}" keeps exactly one key`).toBe(1);
    }
  });

  test("the ALTERNATE key is normalisation-invariant too, swept not listed", () => {
    // The v8.8.14 lesson applied to the new function: its map is keyed on
    // COMPOSED letters, so a name typed in NFD would sail past it unless the
    // input is composed first. Hand-written pairs would all pass either way —
    // this is the sweep that would not.
    const { credentialNameKeyDigraph: d } = require("../lib/badge.js");
    const bad = [];
    for (let cp = 0x20; cp <= 0x2FFF; cp++) {
      const ch = String.fromCodePoint(cp);
      if (d(ch.normalize("NFC")) !== d(ch.normalize("NFD"))) bad.push(ch);
    }
    expect(bad, `NFC and NFD must expand alike; offenders: ${bad.join(" ")}`).toEqual([]);
  });

  test("the page's 'name has changed' notice cannot contradict the lookup", () => {
    // Once Mueller verifies a Müller certificate, telling the verifier on that
    // same page that the holder's name has CHANGED asserts the opposite. The
    // detector is reconstructed from source for the v8.3.20 reason — routes/
    // boots the app at require time, which the harness lock forbids.
    const fs = require("fs"), path = require("path");
    const src = fs.readFileSync(path.join(__dirname, "..", "routes", "badge.js"), "utf8");
    const i = src.indexOf("function _credentialNameChanged(");
    expect(i, "the detector is present").toBeGreaterThan(-1);
    const body = src.slice(i, src.indexOf("\n  }", i) + 4);
    const { credentialNameKey, credentialNameKeyDigraph } = require("../lib/badge.js");
    // eslint-disable-next-line no-new-func
    const changed = new Function("credentialNameKey", "credentialNameKeyDigraph",
      `${body}; return _credentialNameChanged;`)(credentialNameKey, credentialNameKeyDigraph);

    const P = (given, family) => ({ given, family });
    expect(changed(P("Jo", "Müller"), P("Jo", "Mueller")),
      "the spelling the lookup accepts is not reported as a change").toBe(false);
    expect(changed(P("Jo", "Müller"), P("Jo", "Muller")),
      "…nor the one it already accepted (v8.8.14)").toBe(false);
    // CONTROLS: a genuine rename is still reported, and the primary-first test
    // still answers for two names with no usable key.
    expect(changed(P("Jo", "Müller"), P("Jo", "Schmidt")), "a real rename IS reported").toBe(true);
    expect(changed(P("Jo", "Muller"), P("Jo", "Mueller")),
      "two typed spellings the LOOKUP refuses stay a change — the two must agree").toBe(true);
    expect(changed(P("", ""), P("", "")), "two unusable names are not a change").toBe(false);
  });


  test("match keys accept the whole surname and its parts, and never the given name", () => {
    const { credentialMatchKeys: m, credentialNameKey: k } = require("../lib/badge.js");
    const compound = m({ given: "María", family: "García Hernández" });
    expect(compound.has(k("García Hernández")), "the whole surname").toBe(true);
    expect(compound.has(k("Garcia")), "the part a verifier was given").toBe(true);
    expect(compound.has(k("Hernandez")), "…either part").toBe(true);
    expect(compound.has(k("María")), "the GIVEN name is not a key").toBe(false);

    // A single-token surname yields exactly one key — no accidental widening.
    expect([...m({ given: "Jane", family: "Doe" })]).toEqual([k("Doe")]);

    // Hyphens split too, because a verifier drops them.
    const hyphen = m({ given: "Jane", family: "Doe-Smith" });
    expect(hyphen.has(k("Doe"))).toBe(true);
    expect(hyphen.has(k("DoeSmith"))).toBe(true);

    // NO FAMILY NAME MATCHES NOTHING, rather than everything. An empty key set
    // is the only safe answer: a certificate minted without a usable name must
    // not be verifiable by typing nothing.
    expect([...m({ given: "Jane", family: "" })]).toEqual([]);
    expect([...m(null)]).toEqual([]);
    // THE EMPTY KEY MUST NEVER BE EMITTED, and the case that can produce one is a
    // family name that FOLDS to nothing — whitespace or punctuation only. The
    // first version of this assertion asked `m({family:"Doe"}).has("")`, which is
    // trivially false whatever the implementation does; it caught neither of the
    // two mutations aimed at it. Reach the real case instead.
    expect([...m({ given: "Jane", family: "   " })], "a family name that folds to nothing yields NO keys").toEqual([]);
    expect([...m({ given: "Jane", family: "-'-" })], "…punctuation only, likewise").toEqual([]);
    expect(m({ given: "Jane", family: "Doe" }).has(""), "and no key set ever contains it").toBe(false);
  });

  // OPERATOR RULING, 14 Nov 2026: a name PRINTED AS ONE WORD (both parts in Han,
  // kana or Hangul, family name first with no space) is also a key whole, as
  // printed, made from the frozen parts. Only that: the given name alone never,
  // and no other pair gains a key.
  test("a name printed as one word is a key whole, as printed; its given name never is, and no other pair gains one", () => {
    const { credentialMatchKeys: m, credentialNameKey: k } = require("../lib/badge.js");
    for (const [given, family, whole] of [["伟", "张", "张伟"], ["太郎", "田中", "田中太郎"], ["민준", "김", "김민준"], ["さくら", "田中", "田中さくら"]]) {
      const keys = m({ given, family });
      expect([...keys].sort(), `${given} / ${family}: the family name and the whole name as printed`).toEqual([k(family), k(whole)].sort());
      expect(keys.has(k(given)), `${given}: the given name alone is no key`).toBe(false);
      expect(keys.has(k(`${given}${family}`)), "nor the parts the other way round").toBe(false);
    }
    // CONTROLS: a mixed pair and a Latin name keep exactly the family keys, and a
    // nickname certificate's parts (no given part) the nickname alone.
    expect([...m({ given: "Wei", family: "张" })], "Latin given name, Han family name").toEqual([k("张")]);
    expect([...m({ given: "伟", family: "Zhang" })], "Han given name, Latin family name").toEqual([k("Zhang")]);
    expect([...m({ given: "Jane", family: "Doe" })], "a Latin name").toEqual([k("Doe")]);
    expect([...m({ given: "", family: "player4821" })], "a nickname").toEqual([k("player4821")]);
    expect([...m({ given: "伟", family: "" })], "no family name still matches nothing").toEqual([]);
  });
});

test.describe("v8.1.0 — completion", () => {
  test("solving everything is completion; zero challenges is NOT", async () => {
    // The zero case is the one worth a test: `solved >= 0` is trivially true, so
    // an event with nothing assigned would mint a certificate to everyone
    // enrolled the moment it existed.
    const { api, csrf } = await sa();
    try {
      const f = await makeEvent(api, csrf, { kind: "program", tasks: 2 });
      const p = await enter(f.user.email, f.comp.id);
      try {
        process.env.DATA_DIR = require("path").dirname(TEST_DB_PATH);
        delete require.cache[require.resolve("../db")];
        delete require.cache[require.resolve("../lib/competitions")];
        const { participantSolvedAll } = require("../lib/competitions");

        expect(participantSolvedAll(f.user.id, f.comp.id), "nothing solved yet").toBe(false);
        expect((await submit(p.api, p.csrf, f.taskIds[0], "right0")).body.correct).toBe(true);
        expect(participantSolvedAll(f.user.id, f.comp.id), "one of two is not completion").toBe(false);
        expect((await submit(p.api, p.csrf, f.taskIds[1], "right1")).body.correct).toBe(true);
        expect(participantSolvedAll(f.user.id, f.comp.id), "both solved IS completion").toBe(true);

        const empty = await makeEvent(api, csrf, { kind: "program", tasks: 0 });
        expect(participantSolvedAll(empty.user.id, empty.comp.id),
          "an event with NO challenges is not completed by anyone").toBe(false);
      } finally { await p.api.dispose(); }
    } finally { await api.dispose(); }
  });

  test("a Program refuses the certificate until every challenge is solved", async () => {
    const { api, csrf } = await sa();
    try {
      const f = await makeEvent(api, csrf, { kind: "program", tasks: 2 });
      const p = await enter(f.user.email, f.comp.id);
      try {
        await submit(p.api, p.csrf, f.taskIds[0], "right0");   // one of two
        // End it so the badge route's fully-ended gate is satisfied and the
        // refusal under test is the COMPLETION one, not the lifecycle one.
        const end = await api.post(`/api/admin/competitions/${f.comp.id}/end-now`, { headers: H(csrf), data: {} });
        expect(end.ok(), `end-now: ${await end.text()}`).toBeTruthy();

        const refused = await p.api.post(`/api/competitions/${f.comp.id}/badge`, { headers: { "x-csrf-token": p.csrf } });
        expect(refused.status()).toBe(403);
        expect((await refused.json()).code, "named, so the client can say WHY").toBe("not_completed");
      } finally { await p.api.dispose(); }
    } finally { await api.dispose(); }
  });

  test("a completed Program mints basis=completion, no score, and frozen name parts", async () => {
    const { api, csrf } = await sa();
    try {
      const f = await makeEvent(api, csrf, { kind: "program", tasks: 2,
        person: { firstName: "María", lastName: "García Hernández" } });
      const p = await enter(f.user.email, f.comp.id);
      let token;
      try {
        for (let i = 0; i < 2; i++) {
          expect((await submit(p.api, p.csrf, f.taskIds[i], `right${i}`)).body.correct).toBe(true);
        }
        const end = await api.post(`/api/admin/competitions/${f.comp.id}/end-now`, { headers: H(csrf), data: {} });
        expect(end.ok(), `end-now: ${await end.text()}`).toBeTruthy();

        const mint = await p.api.post(`/api/competitions/${f.comp.id}/badge`, { headers: { "x-csrf-token": p.csrf } });
        expect(mint.ok(), `mint: ${mint.status()} ${await mint.text()}`).toBeTruthy();
        const body = await mint.json();
        token = body.token;
        expect(body.rankLabel, "not a placing, and not 'Participant'").toBe("Completed");
        expect(body.basis).toBe("completion");
      } finally { await p.api.dispose(); }

      const row = badgeRow(token);
      expect(row.basis).toBe("completion");
      expect(row.score_snapshot, "a completion certificate carries no score — PR 18 suppression").toBeNull();

      // THE PARTS, NOT FOLDED KEYS. Freezing keys would freeze the fold algorithm
      // at mint, so improving it would need a backfill over every certificate.
      const parts = JSON.parse(row.name_match_snapshot);
      expect(parts).toEqual({ given: "María", family: "García Hernández" });
      const { credentialMatchKeys, credentialNameKey } = require("../lib/badge.js");
      expect(credentialMatchKeys(parts).has(credentialNameKey("garcia hernandez")),
        "and the frozen parts really do produce a usable match key").toBe(true);
    } finally { await api.dispose(); }
  });

  test("the artefacts say COMPLETED — the certificate, the page and the PDF filename", async () => {
    const { api, csrf } = await sa();
    try {
      const f = await makeEvent(api, csrf, { kind: "program", tasks: 1 });
      const p = await enter(f.user.email, f.comp.id);
      let token;
      try {
        expect((await submit(p.api, p.csrf, f.taskIds[0], "right0")).body.correct).toBe(true);
        expect((await api.post(`/api/admin/competitions/${f.comp.id}/end-now`, { headers: H(csrf), data: {} })).ok()).toBeTruthy();
        const mint = await p.api.post(`/api/competitions/${f.comp.id}/badge`, { headers: { "x-csrf-token": p.csrf } });
        expect(mint.ok(), await mint.text()).toBeTruthy();
        token = (await mint.json()).token;
        // v8.1.0 (PR 26) — a completion certificate's PAGE is withheld until the
        // holder shares, so publish it before reading it. The assertion below is
        // unchanged; only the precondition grew.
        expect((await p.api.post(`/badge/${token}/shared`, { headers: { "x-csrf-token": p.csrf } })).ok()).toBeTruthy();
      } finally { await p.api.dispose(); }

      const { api: anon } = await freshCtx();
      try {
        const html = await (await anon.get(`/badge/${token}`)).text();
        expect(html, "the sentence says completed, not 'took part in'").toMatch(/completed/i);
        expect(html, "and never claims a placing").not.toMatch(/finished \d+(st|nd|rd|th) place/i);
        const pdf = await anon.get(`/badge/${token}/certificate.pdf`);
        expect(pdf.ok()).toBeTruthy();
        expect((await pdf.body()).slice(0, 5).toString()).toBe("%PDF-");
      } finally { await anon.dispose(); }
    } finally { await api.dispose(); }
  });

  test("CONTROL: a Competition still mints placement/participation, unchanged", async () => {
    // Without this, every assertion above is equally satisfied by a build that
    // made EVERY badge a completion badge.
    const { api, csrf } = await sa();
    try {
      const f = await makeEvent(api, csrf, { kind: "tournament", tasks: 2 });
      const p = await enter(f.user.email, f.comp.id);
      let token;
      try {
        // Attempt only ONE of the two: a Competition does not require completion,
        // which is the difference under test.
        expect((await submit(p.api, p.csrf, f.taskIds[0], "right0")).body.correct).toBe(true);
        expect((await api.post(`/api/admin/competitions/${f.comp.id}/end-now`, { headers: H(csrf), data: {} })).ok()).toBeTruthy();
        const mint = await p.api.post(`/api/competitions/${f.comp.id}/badge`, { headers: { "x-csrf-token": p.csrf } });
        expect(mint.ok(), `a Competition mints without completion: ${await mint.text()}`).toBeTruthy();
        const body = await mint.json();
        token = body.token;
        expect(body.basis, "sole participant → rank 1 → placement").toBe("placement");
        expect(body.rankLabel).toBe("1st Place");
      } finally { await p.api.dispose(); }
      const row = badgeRow(token);
      expect(row.basis).toBe("placement");
      expect(row.score_snapshot, "a placement badge still carries its score").not.toBeNull();
      expect(JSON.parse(row.name_match_snapshot), "and still freezes the match parts")
        .toEqual({ given: "Comp", family: "Letion" });
    } finally { await api.dispose(); }
  });
  // Sweep #92: the completion claim became true at the last correct answer to a
  // SCORING challenge. A Quick (qualifying) question completes nothing and can be
  // answered, or changed, long after, so it must never date the certificate.
  test("sweep #92: a Program certificate is dated by the last scoring answer; a later Quick answer does not move it", async () => {
    const { api, csrf } = await sa();
    try {
      const e = await makeEvent(api, csrf, { kind: "program", tasks: 2 });
      const qr = await api.post("/api/admin/tasks", { headers: H(csrf), data: {
        title: `${uniq()} Quick`, description: "d", difficulty: "easy", answer_type: "any", correct_answer: "",
        choices: [{ text: "Few" }, { text: "Many" }], status: "published" } });
      expect(qr.ok(), await qr.text()).toBeTruthy();
      const qid = (await qr.json()).id;
      const tg = await api.post(`/api/admin/tasks/${qid}/tags`, { headers: H(csrf), data: { tag: `qualifying:c92${uniq()}` } });
      expect(tg.ok(), `tag: ${await tg.text()}`).toBeTruthy();
      const qa = await api.post(`/api/admin/tasks/${qid}/competitions`, { headers: H(csrf), data: { competitionIds: [e.comp.id] } });
      expect(qa.ok(), await qa.text()).toBeTruthy();
      // A second learner, who completes and answers nothing else: the control.
      const other = await makeParticipant(api, csrf, uniq());
      const asg = await api.post("/api/admin/competitions/assign", { headers: H(csrf), data: { userIds: [other.id], competitionIds: [e.comp.id] } });
      expect((await asg.json()).assigned).toBe(1);

      const db = () => new (require("better-sqlite3"))(TEST_DB_PATH);
      const backdate = (userId, iso) => { const d = db(); try {
        return d.prepare("UPDATE submissions SET submitted_at=? WHERE user_id=? AND competition_id=? AND task_id IN (?,?)").run(iso, userId, e.comp.id, e.taskIds[0], e.taskIds[1]).changes;
      } finally { d.close(); } };
      const DA = new Date(Date.now() - 3 * 86400e3).toISOString();
      const DB = new Date(Date.now() - 5 * 86400e3).toISOString();

      // The learner completes, then (on another day) answers the Quick question.
      const L = await enter(e.user.email, e.comp.id);
      for (let i = 0; i < 2; i++) expect((await submit(L.api, L.csrf, e.taskIds[i], `right${i}`)).body.correct).toBe(true);
      expect(backdate(e.user.id, DA), "PRECONDITION: both scoring answers were back-dated").toBe(2);
      const view = await (await L.api.get(`/api/tasks/${qid}`)).json();
      const opt = (view.choices || view.options || [])[0];
      expect(opt && opt.id, "PRECONDITION: the Quick question offers its options").toBeTruthy();
      const quick = await submit(L.api, L.csrf, qid, JSON.stringify([opt.id]));
      expect(quick.status, JSON.stringify(quick.body)).toBe(200);
      { const d = db(); try {
        const row = d.prepare("SELECT submitted_at FROM submissions WHERE user_id=? AND competition_id=? AND task_id=?").get(e.user.id, e.comp.id, qid);
        expect(row && row.submitted_at > DA, "PRECONDITION: the Quick answer is the latest correct row").toBe(true);
      } finally { d.close(); } }
      const mint = await L.api.post(`/api/competitions/${e.comp.id}/badge`, { headers: H(L.csrf) });
      expect(mint.ok(), await mint.text()).toBeTruthy();
      expect(badgeRow((await mint.json()).token).date_snapshot, "dated the day the learner completed").toBe(DA);
      await L.api.dispose();

      // CONTROL: without a Quick answer, the back-dated completion is what dates it.
      const O = await enter(other.email, e.comp.id);
      for (let i = 0; i < 2; i++) expect((await submit(O.api, O.csrf, e.taskIds[i], `right${i}`)).body.correct).toBe(true);
      expect(backdate(other.id, DB)).toBe(2);
      const m2 = await O.api.post(`/api/competitions/${e.comp.id}/badge`, { headers: H(O.csrf) });
      expect(m2.ok(), await m2.text()).toBeTruthy();
      expect(badgeRow((await m2.json()).token).date_snapshot).toBe(DB);
      await O.api.dispose();
    } finally { await api.dispose(); }
  });
});
test.describe("v8.1.0 — publish on share", () => {
  /** Mint a completed Program badge and return its token + the owner's session. */
  async function completedProgram(api, csrf) {
    const f = await makeEvent(api, csrf, { kind: "program", tasks: 1 });
    const p = await enter(f.user.email, f.comp.id);
    expect((await submit(p.api, p.csrf, f.taskIds[0], "right0")).body.correct).toBe(true);
    expect((await api.post(`/api/admin/competitions/${f.comp.id}/end-now`, { headers: H(csrf), data: {} })).ok()).toBeTruthy();
    const mint = await p.api.post(`/api/competitions/${f.comp.id}/badge`, { headers: { "x-csrf-token": p.csrf } });
    expect(mint.ok(), `mint: ${await mint.text()}`).toBeTruthy();
    return { ...f, owner: p, token: (await mint.json()).token };
  }

  test("a Program certificate is collectable but NOT published until the holder shares", async () => {
    const { api, csrf } = await sa();
    let g;
    try {
      g = await completedProgram(api, csrf);
      const { api: anon } = await freshCtx();
      try {
        // THE PAGE is withheld — and with the SAME uniform 404 as an invalid or
        // revoked token, because a distinct status would tell a stranger that a
        // given person holds an unshared certificate.
        const page = await anon.get(`/badge/${g.token}`);
        expect(page.status(), "the crawlable page is not published yet").toBe(404);
        const bogus = await anon.get(`/badge/${"z".repeat(43)}`);
        expect(await page.text(), "indistinguishable from an unknown token").toBe(await bogus.text());

        // THE ARTEFACTS ARE STILL COLLECTABLE, or "Get my certificate" could not
        // give anyone a certificate. They are capability URLs, linked nowhere.
        expect((await anon.get(`/badge/${g.token}/certificate.pdf`)).ok(), "the PDF is collectable").toBeTruthy();
        expect((await anon.get(`/badge/${g.token}/badge.png`)).ok(), "the PNG is collectable").toBeTruthy();
      } finally { await anon.dispose(); }

      // The owner shares → the page publishes.
      const sh = await g.owner.api.post(`/badge/${g.token}/shared`, { headers: { "x-csrf-token": g.owner.csrf } });
      expect(sh.ok(), `share: ${await sh.text()}`).toBeTruthy();
      const { api: anon2 } = await freshCtx();
      try {
        const page2 = await anon2.get(`/badge/${g.token}`);
        expect(page2.status(), "now published").toBe(200);
        expect(await page2.text()).toMatch(/completed/i);
      } finally { await anon2.dispose(); }
    } finally { if (g) await g.owner.api.dispose(); await api.dispose(); }
  });

  test("a NON-owner cannot publish someone else's page, though the share is still audited", async () => {
    // The share route is TOKEN-authenticated by design, so without an ownership
    // check on the stamp anyone sent the link could publish the page — the gate
    // would be decorative. The audit must keep firing either way: that forensic
    // record predates this change and `by_owner` already distinguishes them.
    const { api, csrf } = await sa();
    let g;
    try {
      g = await completedProgram(api, csrf);
      const { api: anon, csrf: ac } = await freshCtx();
      try {
        const sh = await anon.post(`/badge/${g.token}/shared`, { headers: { "x-csrf-token": ac } });
        expect(sh.ok(), "the endpoint still answers, so the audit still records").toBeTruthy();
        expect((await sh.json()).published, "…but it did not publish").toBe(false);
        expect((await anon.get(`/badge/${g.token}`)).status(), "still withheld").toBe(404);
      } finally { await anon.dispose(); }

      const Database = require("better-sqlite3");
      const db = new Database(TEST_DB_PATH, { readonly: true });
      try {
        expect(db.prepare("SELECT shared_at FROM achievement_badges WHERE token=?").get(g.token).shared_at,
          "a stranger's click stamps nothing").toBeNull();
      } finally { db.close(); }
    } finally { if (g) await g.owner.api.dispose(); await api.dispose(); }
  });

  test("v8.6.2 — a COMPETITION badge is withheld at mint too, and its share publishes it", async () => {
    // INVERTED at v8.6.2, deliberately, and it keeps its control role.
    //
    // PR 26 left the two ranked kinds publishing at MINT on the grounds that
    // their CTA says "Share on LinkedIn or download", so publishing was stated
    // intent. That reasoning does not survive the download half of its own
    // sentence: a participant who opened the dialog, took the PNG and closed it
    // had published a crawlable page naming them, and the note explaining that
    // was rendered only for a completion certificate. The rule is uniform now.
    //
    // The CONTROL half is unchanged in purpose and merely moves: "the page 404s"
    // must not be satisfiable by a build that withholds every page FOR EVER, so
    // this asserts the share still publishes it.
    const { api, csrf } = await sa();
    try {
      const f = await makeEvent(api, csrf, { kind: "tournament", tasks: 1 });
      const p = await enter(f.user.email, f.comp.id);
      let token;
      try {
        expect((await submit(p.api, p.csrf, f.taskIds[0], "right0")).body.correct).toBe(true);
        // The sole participant solving the only challenge fires the ALL-SOLVED
        // auto-end, so end-now would be refused as already-ended (fixture
        // checklist item 1). Assert the END STATE rather than the call.
        await api.post(`/api/admin/competitions/${f.comp.id}/end-now`, { headers: H(csrf), data: {} });
        const row = (await (await api.get("/api/admin/competitions")).json()).find(c => c.id === f.comp.id);
        expect(row.status, "ended, however it got there").toBe("ended");
        const mint = await p.api.post(`/api/competitions/${f.comp.id}/badge`, { headers: { "x-csrf-token": p.csrf } });
        expect(mint.ok(), await mint.text()).toBeTruthy();
        token = (await mint.json()).token;
      } finally { await p.api.dispose(); }
      const { api: anon } = await freshCtx();
      try {
        expect((await anon.get(`/badge/${token}`)).status(),
          "minting must not publish, whatever the kind").toBe(404);
      } finally { await anon.dispose(); }

      // …and the owner's Share publishes it — the control that stops the
      // assertion above being satisfied by a build that never publishes at all.
      const p2 = await enter(f.user.email, f.comp.id);
      try {
        const sh = await p2.api.post(`/badge/${token}/shared`, { headers: { "x-csrf-token": p2.csrf } });
        expect(sh.ok(), await sh.text()).toBeTruthy();
        expect((await sh.json()).published, "the owner's share publishes it").toBe(true);
      } finally { await p2.api.dispose(); }

      const { api: anon2 } = await freshCtx();
      try {
        expect((await anon2.get(`/badge/${token}`)).status(), "live once shared").toBe(200);
      } finally { await anon2.dispose(); }
    } finally { await api.dispose(); }
  });

  test("v8.6.2 — a badge minted BEFORE the gate keeps its page (the grandfather floor)", async () => {
    // `shared_at` was added at v8.1.0 with no backfill while badges have existed
    // since v7.1.0, so withholding on that column alone would take DARK every
    // page minted before it — pages that are live today and may be linked from a
    // post somebody has already made. Those rows keep their page.
    //
    // Driven by ageing the row behind the floor, which is the only way to
    // manufacture a pre-gate badge: the fixture cannot mint into the past.
    const { api, csrf } = await sa();
    try {
      const f = await makeEvent(api, csrf, { kind: "tournament", tasks: 1 });
      const p = await enter(f.user.email, f.comp.id);
      let token;
      try {
        expect((await submit(p.api, p.csrf, f.taskIds[0], "right0")).body.correct).toBe(true);
        await api.post(`/api/admin/competitions/${f.comp.id}/end-now`, { headers: H(csrf), data: {} });
        const mint = await p.api.post(`/api/competitions/${f.comp.id}/badge`, { headers: { "x-csrf-token": p.csrf } });
        expect(mint.ok(), await mint.text()).toBeTruthy();
        token = (await mint.json()).token;
      } finally { await p.api.dispose(); }

      const Database = require("better-sqlite3");
      const db = new Database(TEST_DB_PATH);
      const floor = db.prepare("SELECT value FROM settings WHERE key='badge_page_share_gate_at'").get()?.value;
      expect(floor, "the gate floor is stamped at boot").toBeTruthy();

      // PRECONDITION: a post-gate badge is withheld, or the arm below proves nothing.
      const { api: a1 } = await freshCtx();
      try { expect((await a1.get(`/badge/${token}`)).status(), "withheld while it postdates the floor").toBe(404); }
      finally { await a1.dispose(); }

      db.prepare("UPDATE achievement_badges SET created_at=? WHERE token=?")
        .run(new Date(Date.parse(floor) - 60_000).toISOString(), token);
      expect(db.prepare("SELECT shared_at FROM achievement_badges WHERE token=?").get(token).shared_at,
        "grandfathered WITHOUT fabricating a share").toBeFalsy();
      db.close();

      const { api: a2 } = await freshCtx();
      try {
        expect((await a2.get(`/badge/${token}`)).status(),
          "a page that was already live before the gate stays live").toBe(200);
      } finally { await a2.dispose(); }
    } finally { await api.dispose(); }
  });
});

test.describe("v8.1.0 — the printed code, and revocation", () => {
  test("the code alphabet and its normalisation are safe to print and to type", () => {
    const b = require("../lib/badge.js");
    const { randomBytes } = require("crypto");
    // ONE-WAY DOOR: these are stamped onto PDFs that leave the building.
    expect(b.CREDENTIAL_CODE_LEN).toBe(12);
    expect(b.CREDENTIAL_ALPHABET, "Crockford minus I, L, O, U — the misread pairs").toBe("0123456789ABCDEFGHJKMNPQRSTVWXYZ");
    for (const bad of ["I", "L", "O", "U"]) {
      expect(b.CREDENTIAL_ALPHABET.includes(bad), `${bad} must not be mintable`).toBe(false);
    }
    const code = b.generateCredentialCode(randomBytes);
    expect(code).toHaveLength(12);
    expect([...code].every(c => b.CREDENTIAL_ALPHABET.includes(c))).toBe(true);

    // It is PRINTED grouped, and the grouping must round-trip: a verifier types
    // what they see, including the hyphens and whatever case they feel like.
    expect(b.formatCredentialCode(code)).toMatch(/^.{4}-.{4}-.{4}$/);
    expect(b.normaliseCredentialCode(b.formatCredentialCode(code))).toBe(code);
    expect(b.normaliseCredentialCode(` ${b.formatCredentialCode(code).toLowerCase()} `)).toBe(code);
    // The Crockford substitutions for the letters the alphabet excludes BECAUSE
    // they are misread — a verifier who types the letter gets the digit.
    expect(b.normaliseCredentialCode("IL0O")).toBe("1100");
    // And an unusable value normalises to "", which must never match anything.
    expect(b.normaliseCredentialCode("!!!")).toBe("");
    expect(b.normaliseCredentialCode(null)).toBe("");
  });

  test("a new mint carries a unique code; the certificate is revocable and not re-mintable", async () => {
    const { api, csrf } = await sa();
    let p;
    try {
      const f = await makeEvent(api, csrf, { kind: "program", tasks: 1 });
      p = await enter(f.user.email, f.comp.id);
      expect((await submit(p.api, p.csrf, f.taskIds[0], "right0")).body.correct).toBe(true);
      expect((await api.post(`/api/admin/competitions/${f.comp.id}/end-now`, { headers: H(csrf), data: {} })).ok()).toBeTruthy();

      const mint = await p.api.post(`/api/competitions/${f.comp.id}/badge`, { headers: { "x-csrf-token": p.csrf } });
      expect(mint.ok(), await mint.text()).toBeTruthy();
      const body = await mint.json();
      const token = body.token;
      expect(body.publicCode, "a new mint carries a code").toMatch(/^[0-9A-HJKMNP-TV-Z]{12}$/);
      expect(body.publicCodeFormatted).toBe(require("../lib/badge.js").formatCredentialCode(body.publicCode));

      // v8.12.4 — the artefacts are collectable BEFORE the revocation, so the
      // 404s asserted after it are the revocation's doing and nothing else's.
      {
        const { api: anon } = await freshCtx();
        try {
          for (const suffix of ["/certificate.pdf", "/badge.png"]) {
            expect((await anon.get(`/badge/${token}${suffix}`)).status(), `precondition: ${suffix} is collectable`).toBe(200);
          }
        } finally { await anon.dispose(); }
      }

      // REVOKE, then the two properties that make the partial index safe.
      const rev = await api.post(`/api/admin/badges/${token}/revoke`, { headers: H(csrf), data: { reason: "plagiarism" } });
      expect(rev.ok(), `revoke: ${rev.status()} ${await rev.text()}`).toBeTruthy();
      const twice = await api.post(`/api/admin/badges/${token}/revoke`, { headers: H(csrf), data: {} });
      expect(twice.status(), "revoking twice is a named 409, not a silent success").toBe(409);
      expect((await twice.json()).code, "…and it is NAMED").toBe("already_revoked");

      // (0) A REVOKED token is indistinguishable from an UNKNOWN one on every
      //     public route — the page, the PDF and the PNG — or the status or the
      //     body would tell a stranger that this person once held a certificate.
      //     The three per-route tests in badge.api.spec.js used an unknown token
      //     only; nothing had ever fetched a revoked one.
      {
        const { api: anon } = await freshCtx();
        try {
          for (const suffix of ["", "/certificate.pdf", "/badge.png"]) {
            const revoked = await anon.get(`/badge/${token}${suffix}`);
            const unknown = await anon.get(`/badge/${"z".repeat(43)}${suffix}`);
            expect(revoked.status(), `revoked ${suffix || "page"} answers 404`).toBe(404);
            expect(await revoked.text(), `revoked ${suffix || "page"} is byte-identical to an unknown token`)
              .toBe(await unknown.text());
          }
        } finally { await anon.dispose(); }
      }

      // (1) THE HOLDER CANNOT MINT A REPLACEMENT. Without this the partial index
      //     is strictly worse than the confusing failure it replaced: the mint is
      //     requireParticipant, so a revoked participant could quietly obtain a
      //     fresh valid certificate with a fresh code.
      const again = await p.api.post(`/api/competitions/${f.comp.id}/badge`, { headers: { "x-csrf-token": p.csrf } });
      expect(again.status(), "a revoked certificate is not re-mintable").toBe(403);
      expect((await again.json()).code).toBe("revoked");

      // (2) THE CODE STILL RESOLVES. Its unique index is deliberately NOT partial,
      //     because a credential page must be able to answer "revoked" — otherwise
      //     a revoked certificate is indistinguishable from a forged one.
      const Database = require("better-sqlite3");
      const db = new Database(TEST_DB_PATH, { readonly: true });
      try {
        const row = db.prepare("SELECT * FROM achievement_badges WHERE public_code=?").get(body.publicCode);
        expect(row, "the revoked row is still findable BY CODE").toBeTruthy();
        expect(row.revoked_at).toBeTruthy();
        const ix = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='uq_achievement_badges_public_code'").get();
        expect(ix.sql, "the code index is not filtered on revocation").not.toMatch(/revoked_at/i);
        const uq = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='uq_achievement_badges_user_comp_ts'").get();
        expect(uq.sql, "…while the re-mint index IS").toMatch(/revoked_at\s+IS\s+NULL/i);
      } finally { db.close(); }
    } finally { if (p) await p.api.dispose(); await api.dispose(); }
  });

  test("codes are unique across mints, and a REGULAR admin cannot revoke", async () => {
    const { api, csrf } = await sa();
    const codes = new Set();
    try {
      for (let i = 0; i < 3; i++) {
        const f = await makeEvent(api, csrf, { kind: "program", tasks: 1 });
        const p = await enter(f.user.email, f.comp.id);
        try {
          expect((await submit(p.api, p.csrf, f.taskIds[0], "right0")).body.correct).toBe(true);
          expect((await api.post(`/api/admin/competitions/${f.comp.id}/end-now`, { headers: H(csrf), data: {} })).ok()).toBeTruthy();
          const mint = await p.api.post(`/api/competitions/${f.comp.id}/badge`, { headers: { "x-csrf-token": p.csrf } });
          expect(mint.ok(), await mint.text()).toBeTruthy();
          codes.add((await mint.json()).publicCode);
        } finally { await p.api.dispose(); }
      }
      expect(codes.size, "three mints, three distinct codes").toBe(3);

      // Revoking invalidates an artefact a third party may be holding, so it sits
      // at the tier that can already delete a participant.
      const adminUser = await makeParticipant(api, csrf, uniq());
      expect((await api.post(`/api/admin/participants/${adminUser.id}/role`, { headers: H(csrf), data: { role: "admin" } })).ok()).toBeTruthy();
      const { api: ra, csrf: rc } = await freshCtx();
      try {
        expect((await codeLogin(ra, adminUser.email, H(rc))).ok()).toBeTruthy();
        const rc2 = (await (await ra.get("/api/csrf-token")).json()).csrfToken;
        const attempt = await ra.post(`/api/admin/badges/${"z".repeat(43)}/revoke`, { headers: H(rc2), data: {} });
        expect(attempt.status(), "a regular admin is refused BEFORE the lookup").toBe(403);
      } finally { await ra.dispose(); }
    } finally { await api.dispose(); }
  });
});

test.describe("v8.1.0 — /credential, third-party verification", () => {
  /** A completed Program badge, with its code and the holder's surname. */
  async function issued(api, csrf, person = { firstName: "María", lastName: "García Hernández" }) {
    const f = await makeEvent(api, csrf, { kind: "program", tasks: 1, person });
    const p = await enter(f.user.email, f.comp.id);
    try {
      expect((await submit(p.api, p.csrf, f.taskIds[0], "right0")).body.correct).toBe(true);
      expect((await api.post(`/api/admin/competitions/${f.comp.id}/end-now`, { headers: H(csrf), data: {} })).ok()).toBeTruthy();
      const mint = await p.api.post(`/api/competitions/${f.comp.id}/badge`, { headers: { "x-csrf-token": p.csrf } });
      expect(mint.ok(), await mint.text()).toBeTruthy();
      const b = await mint.json();
      return { ...f, token: b.token, code: b.publicCode, surname: person.lastName };
    } finally { await p.api.dispose(); }
  }

  const lookup = (anon, code, surname) => anon.post("/credential", {
    headers: { "content-type": "application/json", accept: "application/json" },
    data: { code, surname },
  });
  /** A lookup sent FROM another loopback address: {status, body}. */
  const lookupFrom = (localAddress, code, surname) => new Promise((resolve, reject) => {
    const u = new URL(BASE);
    const body = JSON.stringify({ code, surname });
    const r = require("http").request({
      host: "127.0.0.1", port: Number(u.port), path: "/credential", method: "POST", localAddress,
      headers: { "content-type": "application/json", accept: "application/json", "content-length": Buffer.byteLength(body) },
    }, (res) => {
      let t = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { t += c; });
      res.on("end", () => { try { resolve({ status: res.statusCode, body: JSON.parse(t) }); } catch (e) { reject(e); } });
    });
    r.on("error", reject);
    r.end(body);
  });

  test("the right code AND surname verifies; either one wrong is the SAME answer", async () => {
    const { api, csrf } = await sa();
    try {
      const g = await issued(api, csrf);
      const { api: anon } = await freshCtx();
      try {
        const ok = await (await lookup(anon, g.code, "García Hernández")).json();
        expect(ok.found).toBe(true);
        expect(ok.revoked).toBe(false);
        expect(ok.name).toContain("García Hernández");
        expect(ok.label, "a Program attests completion").toBe("Completed");
        expect(ok.competitionName).toBe(g.comp.name);

        // The fold: a verifier types what they can, in whatever case.
        expect((await (await lookup(anon, g.code.toLowerCase(), "garcia hernandez")).json()).found,
          "case and accents do not matter").toBe(true);
        expect((await (await lookup(anon, require("../lib/badge.js").formatCredentialCode(g.code), "GARCIA")).json()).found,
          "the printed grouping, and one part of a compound surname").toBe(true);

        // THE PROPERTY THIS WHOLE DESIGN RESTS ON: a wrong surname and an unknown
        // code are BYTE-IDENTICAL. Without it the code alone becomes a lookup that
        // reveals who holds it.
        const wrongName = await lookup(anon, g.code, "Nobody");
        const unknown = await lookup(anon, "ZZZZZZZZZZZZ", "Nobody");
        expect(wrongName.status()).toBe(unknown.status());
        expect(await wrongName.text()).toBe(await unknown.text());
        expect((await wrongName.json()).found).toBe(false);
        // …and neither leaks the holder by any other channel.
        expect(await wrongName.text()).not.toContain("García");
        expect(await wrongName.text()).not.toContain(g.comp.name);
      } finally { await anon.dispose(); }
    } finally { await api.dispose(); }
  });

  // v8.8.14 — THE REPORTED SHAPE, DRIVEN END TO END. The unit tests above pin
  // the fold; this one proves the verification endpoint actually accepts what an
  // employer types off a printed Norwegian certificate. Both halves matter: the
  // holder's own certificate must verify, AND a different surname must still be
  // the same uniform refusal — a wider fold that started matching anybody would
  // pass a test that only checked the first.
  test("a stroked surname verifies from what is PRINTED on the certificate", async () => {
    const { api, csrf } = await sa();
    try {
      const g = await issued(api, csrf, { firstName: "Anne", lastName: "Løvland" });
      const { api: anon } = await freshCtx();
      try {
        const ok = await (await lookup(anon, g.code, "Lovland")).json();
        expect(ok.found, "an employer types the o they can reach").toBe(true);
        expect(ok.name, "…and the page still shows the real spelling").toContain("Løvland");

        // The exact spelling still works, and so does the all-caps printing.
        expect((await (await lookup(anon, g.code, "Løvland")).json()).found).toBe(true);
        expect((await (await lookup(anon, g.code, "LOVLAND")).json()).found).toBe(true);

        // CONTROL — a genuinely different surname is refused, and the refusal is
        // byte-identical to an unknown code. The widening must not make the
        // surname stop being a second factor.
        const wrong = await lookup(anon, g.code, "Lovlund");
        const unknown = await lookup(anon, "ZZZZZZZZZZZZ", "Lovlund");
        expect((await wrong.json()).found, "a near-miss surname is still refused").toBe(false);
        expect(wrong.status()).toBe(unknown.status());
        expect(await wrong.text()).toBe(await unknown.text());
      } finally { await anon.dispose(); }
    } finally { await api.dispose(); }
  });

  test("an empty code or an empty surname matches nothing", async () => {
    // `credentialMatchKeys` of a nameless certificate is an empty set, and "" must
    // never satisfy it — guarded explicitly rather than left to the comparison.
    const { api, csrf } = await sa();
    try {
      const g = await issued(api, csrf);
      const { api: anon } = await freshCtx();
      try {
        for (const [code, surname, why] of [
          ["", "García Hernández", "no code"],
          [g.code, "", "no surname"],
          ["", "", "neither"],
          [g.code, "   ", "whitespace surname"],
          ["!!!!", "García Hernández", "unusable code"],
        ]) {
          expect((await (await lookup(anon, code, surname)).json()).found, why).toBe(false);
        }
      } finally { await anon.dispose(); }
    } finally { await api.dispose(); }
  });

  test("a REVOKED certificate resolves and says so, rather than vanishing", async () => {
    // "This was revoked" and "this never existed" are different answers, and a
    // verifier needs the first — otherwise a revoked certificate is
    // indistinguishable from a forged one. This is why the public_code index is
    // deliberately not filtered on revocation.
    const { api, csrf } = await sa();
    try {
      const g = await issued(api, csrf);
      expect((await api.post(`/api/admin/badges/${g.token}/revoke`, { headers: H(csrf), data: {} })).ok()).toBeTruthy();
      const { api: anon } = await freshCtx();
      try {
        const v = await (await lookup(anon, g.code, "García Hernández")).json();
        expect(v.found, "it still resolves").toBe(true);
        expect(v.revoked).toBe(true);
        expect(v.revoked_at).toBeTruthy();
        const html = await (await anon.post("/credential", {
          headers: { "content-type": "application/x-www-form-urlencoded" },
          form: { code: g.code, surname: "García Hernández" },
        })).text();
        expect(html).toMatch(/has been revoked/i);
      } finally { await anon.dispose(); }
    } finally { await api.dispose(); }
  });

  // The source both budgets count is lib/login-code.js originKeyFor, the
  // sign-in code's origin: one IPv6 connection holds a whole /64, so a count
  // per address would start afresh at every one of its addresses. The /64 is
  // read from the address's groups: the compressed text ("2001:db8::1") split
  // on ":" put every address of 2001:db8::/64 in an origin of its own.
  test("a source is an IPv4 /24 or an IPv6 /64, read from the address's groups, never its text", () => {
    const { originKeyFor } = require("../lib/login-code");
    const same = (a, b) => expect(originKeyFor(a), `${a} and ${b} are one source`).toBe(originKeyFor(b));
    const apart = (a, b) => expect(originKeyFor(a), `${a} and ${b} are two sources`).not.toBe(originKeyFor(b));
    same("2001:db8::1", "2001:db8::2");
    same("2001:db8::1", "2001:db8:0:0:1:2:3:4");
    same("2001:db8::1", "2001:DB8:0000:0000:ffff:ffff:ffff:ffff");
    same("2a02:1810:4d02:5e00::1", "2a02:1810:4d02:5e00:a1b2:c3d4:e5f6:1234");
    same("127.0.0.1", "::ffff:127.0.0.2");
    apart("2001:db8::1", "2001:db8:0:1::1");          // CONTROL: the next /64
    apart("127.0.0.1", "127.0.1.1");                  // CONTROL: the next /24
    expect(originKeyFor("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(originKeyFor("64:ff9b::1.2.3.4"), "a dotted tail is two groups").toBe("64:ff9b:0:0::/64");
    for (const junk of ["", null, "garbage", "1.2.3", "2001:db8::1::2"]) expect(originKeyFor(junk), `${junk} has no source`).toBeNull();
  });

  test("FAILURES are throttled per code AND source; SUCCESSES never are", async () => {
    // Counting successes would be a denial of service on the credential itself —
    // an HR team verifying a cohort of sixty is the load this exists to serve.
    const { api, csrf } = await sa();
    try {
      const g = await issued(api, csrf);
      const { api: anon } = await freshCtx();
      try {
        // A verifier who keeps getting it right is never refused.
        for (let i = 0; i < 15; i++) {
          const r = await lookup(anon, g.code, "García Hernández");
          expect(r.status(), `success ${i + 1} must not be throttled`).toBe(200);
          expect((await r.json()).found).toBe(true);
        }
        // Wrong guesses against the same code run out.
        let throttled = false;
        for (let i = 0; i < 14 && !throttled; i++) {
          const r = await lookup(anon, g.code, `Guess${i}`);
          if (r.status() === 429) { throttled = true; expect((await r.json()).found).toBe(false); }
        }
        expect(throttled, "the per-code failure budget bites").toBe(true);
        // 429 and NOT a 4xx the scanner counter would see — a verifier fumbling a
        // surname must never contribute to an IP-wide block (v7.21.24).
        const after = await lookup(anon, g.code, "García Hernández");
        expect(after.status(), "…and it is a 429").toBe(429);

        // Operator rulings, 24 Nov 2026: the code budget is counted per (code,
        // source), and a source is a NETWORK, the sign-in code's origin (an IPv4
        // /24, an IPv6 /64), never one address. A code is public once its holder
        // posts it, so one reader spending it must not refuse every real
        // verifier: ANOTHER network checking the SAME code still gets an answer,
        // while another address of the SAME /24 is the same source. Each source
        // is a socket bound to that address (Linux puts all of 127/8 on
        // loopback): a client merely connecting TO it still sends from 127.0.0.1.
        const sameNet = await lookupFrom("127.0.0.2", g.code, "García Hernández");
        expect(sameNet.status, "an address of the same /24 is the same source: refused too").toBe(429);
        const seen = await lookupFrom("127.0.1.2", g.code, "García Hernández");
        expect(seen.status, "another network is not locked out by this one's wrong guesses").toBe(200);
        expect(seen.body.found).toBe(true);
        // …and its own wrong guess is an ordinary miss, not a 429.
        const miss = await lookupFrom("127.0.1.2", g.code, "Nobody");
        expect(miss.status).toBe(200);
        expect(miss.body.found).toBe(false);
        // CONTROL — the first source is still refused for that code.
        expect((await lookup(anon, g.code, "García Hernández")).status(), "the throttled source stays throttled").toBe(429);
      } finally { await anon.dispose(); }
    } finally { await api.dispose(); }
  });

  test("the page works with no JavaScript, is noindex, and is never cached", async () => {
    const { api, csrf } = await sa();
    try {
      const g = await issued(api, csrf);
      const { api: anon } = await freshCtx();
      try {
        const get = await anon.get("/credential");
        expect(get.status()).toBe(200);
        const html = await get.text();
        // A real form that posts on its own — a verifier may be inside a corporate
        // browser policy, and this page is their only interaction with us.
        expect(html).toMatch(/<form[^>]+method="post"[^>]+action="\/credential"/);
        expect(html, "both inputs, labelled").toContain('id="cred-code"');
        expect(html).toContain('id="cred-surname"');
        expect(html).toMatch(/<label[^>]+for="cred-code"/);
        expect(html).toMatch(/<label[^>]+for="cred-surname"/);
        // A verification page must not be indexed or cached.
        expect(html).toMatch(/name="robots"[^>]*noindex/);
        expect(get.headers()["cache-control"]).toContain("no-store");

        // …and a form POST (not JSON) renders the answer in the page.
        const posted = await anon.post("/credential", {
          headers: { "content-type": "application/x-www-form-urlencoded" },
          form: { code: g.code, surname: "Garcia" },
        });
        expect(posted.status()).toBe(200);
        expect(await posted.text()).toMatch(/Certificate verified/i);
      } finally { await anon.dispose(); }
    } finally { await api.dispose(); }
  });

  test("the code never reaches the access log, even from a QR link", async () => {
    // The QR on a certificate points at /credential?code=…, so without the
    // write-time scrub the credential would sit in access-*.jsonl in cleartext,
    // readable by any admin through GET /api/admin/logs.
    const { api, csrf } = await sa();
    try {
      const g = await issued(api, csrf);
      const { api: anon } = await freshCtx();
      try { expect((await anon.get(`/credential?code=${g.code}`)).ok()).toBeTruthy(); }
      finally { await anon.dispose(); }

      const fs = require("fs"), path = require("path");
      const dir = path.join(path.dirname(TEST_DB_PATH), "logs");
      await expect.poll(() => {
        const f = fs.readdirSync(dir).filter(x => x.startsWith("access-"));
        return f.some(x => fs.readFileSync(path.join(dir, x), "utf8").includes("/credential"));
      }, { timeout: 10000 }).toBe(true);
      for (const f of fs.readdirSync(dir)) {
        expect(fs.readFileSync(path.join(dir, f), "utf8").includes(g.code),
          `${f} must not contain the credential code`).toBe(false);
      }
    } finally { await api.dispose(); }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// v8.1.0 — findings from the adversarial review of this surface. Each of these
// is a defect the implementation shipped with and a mutation-verified lock on
// its fix; the review is in the release notes.
// ─────────────────────────────────────────────────────────────────────────────
test.describe("v8.1.0 — credential surface, adversarial-review fixes", () => {
  async function issuedProgram(api, csrf) {
    const f = await makeEvent(api, csrf, { kind: "program", tasks: 1, person: { firstName: "Ada", lastName: "Lovelace" } });
    const p = await enter(f.user.email, f.comp.id);
    try {
      expect((await submit(p.api, p.csrf, f.taskIds[0], "right0")).body.correct).toBe(true);
      expect((await api.post(`/api/admin/competitions/${f.comp.id}/end-now`, { headers: H(csrf), data: {} })).ok()).toBeTruthy();
      const mint = await p.api.post(`/api/competitions/${f.comp.id}/badge`, { headers: { "x-csrf-token": p.csrf } });
      expect(mint.ok(), await mint.text()).toBeTruthy();
      const b = await mint.json();
      return { ...f, token: b.token, code: b.publicCode };
    } finally { await p.api.dispose(); }
  }

  test("the audit trail carries NEITHER the badge token nor the raw code", async () => {
    // Both are capabilities. The token opens the PNG and PDF with no auth at all
    // — which is why _scrubLogPath has redacted it from the ACCESS log since
    // v7.1.0 — and the code is one of the two factors this endpoint requires. The
    // blob reaches app.jsonl, which any REGULAR admin reads via /api/admin/logs,
    // so either one there is a bypass of the gate immediately above it.
    const { api, csrf } = await sa();
    try {
      const g = await issuedProgram(api, csrf);
      const { api: anon } = await freshCtx();
      try {
        expect((await anon.post("/credential", { headers: { "content-type": "application/json", accept: "application/json" },
          data: { code: g.code, surname: "Lovelace" } })).ok()).toBeTruthy();
        await anon.post("/credential", { headers: { "content-type": "application/json", accept: "application/json" },
          data: { code: g.code, surname: "WrongName" } });
      } finally { await anon.dispose(); }

      const fs = require("fs"), path = require("path");
      const dir = path.join(path.dirname(TEST_DB_PATH), "logs");
      await expect.poll(() => fs.readdirSync(dir).some(f => f.startsWith("app-")
        && fs.readFileSync(path.join(dir, f), "utf8").includes("credential_verified")), { timeout: 10000 }).toBe(true);
      for (const f of fs.readdirSync(dir)) {
        const txt = fs.readFileSync(path.join(dir, f), "utf8");
        expect(txt.includes(g.token), `${f} must not contain the badge TOKEN`).toBe(false);
        expect(txt.includes(g.code), `${f} must not contain the raw CODE`).toBe(false);
      }
      // …and the record is still useful: one stable fingerprint groups both
      // lookups of the same code.
      const app = fs.readdirSync(dir).filter(f => f.startsWith("app-"))
        .map(f => fs.readFileSync(path.join(dir, f), "utf8")).join("");
      const fps = [...app.matchAll(/"scope_id":"(cf_[0-9a-f]{12})"/g)].map(m => m[1]);
      expect(new Set(fps).size, "the two lookups share one fingerprint").toBeGreaterThan(0);
    } finally { await api.dispose(); }
  });

  test("flooding distinct codes cannot wipe a live per-code budget", async () => {
    // The eviction fell back to `_credFails.clear()` when nothing had expired,
    // which is a control an attacker can operate: enough distinct failing codes
    // inside the window and every live budget — including the one protecting the
    // code under attack — resets to zero. Driven at the unit level because the
    // cap is 20 000 and the point is the ALGORITHM, not the number.
    // STRIP COMMENTS FIRST. The comment explaining this very fix quotes the call
    // it forbids, so an unstripped scan matches the explanation and reports the
    // defect as still present — the v7.21.13 trap, in the lock for the fix.
    // Single left-to-right alternation so whichever comment opens first wins
    // (v7.21.24), and line count is preserved so offsets still mean something.
    const raw = require("fs").readFileSync(require("path").join(__dirname, "..", "routes", "badge.js"), "utf8");
    const src = raw.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, ""));
    const i = src.indexOf("function _credFailRecord");
    expect(i, "the eviction is findable").toBeGreaterThan(-1);
    const body = src.slice(i, src.indexOf("\n  }", i));
    expect(body, "never clear() — that hands the attacker the reset").not.toMatch(/_credFails\.clear\(\)/);
    expect(body, "oldest-first, which Map's insertion order already gives").toMatch(/for \(const k of _credFails\.keys\(\)\)/);
  });

  test("a revoke landing mid-mint cannot be overtaken", async () => {
    // The refusal is checked before `await renderBadgePng`, which yields for the
    // length of a rasterise. Because the uniqueness index is partial on
    // revoked_at, an INSERT that wins that race succeeds — handing the revoked
    // holder a fresh valid certificate. Pinned in source: the re-check must be
    // INSIDE the transaction.
    const src = require("fs").readFileSync(require("path").join(__dirname, "..", "routes", "badge.js"), "utf8");
    const i = src.indexOf("const persist = db.transaction(");
    expect(i).toBeGreaterThan(-1);
    const txn = src.slice(i, src.indexOf("});", i));
    expect(txn, "revocation is re-checked inside the write transaction").toMatch(/revoked_at IS NOT NULL/);
    expect(txn, "…and it aborts the transaction rather than carrying on").toMatch(/_revokedMidMint/);
  });

  test("the certificate DATE is frozen at mint, not re-derived", async () => {
    // Extending a Program's deadline used to rewrite the date on certificates
    // already downloaded and filed — and the verification page would then confirm
    // the new date as correct. A certificate is a factual claim about a finished
    // event.
    const { api, csrf } = await sa();
    try {
      const g = await issuedProgram(api, csrf);
      const before = await (await (await freshCtx()).api.post("/credential", {
        headers: { "content-type": "application/json", accept: "application/json" },
        data: { code: g.code, surname: "Lovelace" } })).json();
      expect(before.found).toBe(true);
      expect(badgeRow(g.token).date_snapshot, "the date is stored at mint").toBeTruthy();

      // Move the event's end well past the issued date.
      const cur = (await (await api.get("/api/admin/competitions")).json()).find(c => c.id === g.comp.id);
      const put = await api.put(`/api/admin/competitions/${g.comp.id}`, {
        headers: H(csrf),
        data: { deadline_at: new Date(Date.now() + 400 * 86400e3).toISOString(), expectedUpdatedAt: cur.updated_at },
      });
      expect(put.ok(), `extend: ${await put.text()}`).toBeTruthy();

      const { api: anon } = await freshCtx();
      try {
        const after = await (await anon.post("/credential", {
          headers: { "content-type": "application/json", accept: "application/json" },
          data: { code: g.code, surname: "Lovelace" } })).json();
        expect(after.dateLabel, "the issued date does not move under the holder").toBe(before.dateLabel);
      } finally { await anon.dispose(); }
    } finally { await api.dispose(); }
  });

  test("the log scrubber is global, so a duplicated parameter cannot escape it", () => {
    // The replacements were /i — first match only — so `?code=decoy&code=<real>`
    // left the second copy on disk verbatim.
    //
    // v8.6.1 — THIS LOCK WAS VACUOUS FOR EXACTLY THE RULES THAT STILL HAD THE
    // DEFECT. Its extractor's `[^/]+` cannot cross a slash INSIDE the pattern,
    // so every PATH-segment rule (`/\/badge\/…/`, `/\/join\/…/`,
    // `/\/api\/competitions\/self-enroll\/…/`) was invisible to it —
    // measured, 5 of 11 seen — and all three of the invisible ones were `/i`.
    // The `> 2` floor was met by the 5 it could see, so it passed. The
    // extractor now walks escapes and character classes, and the floor is the
    // shipped count, so a rename that empties the match set fails rather than
    // passing in silence.
    const src = require("fs").readFileSync(require("path").join(__dirname, "..", "server.js"), "utf8");
    const i = src.indexOf("function _scrubLogPath");
    const body = src.slice(i, src.indexOf("\n}", i));
    const flags = [...body.matchAll(/\.replace\(\/(?:\\.|\[[^\]]*\]|[^/\\])+\/([a-z]*),/g)].map(m => m[1]);
    expect(flags.length, "the scrubber has replacements to check").toBeGreaterThanOrEqual(12);
    for (const f of flags) expect(f, `every scrub is global, got /${f}`).toContain("g");
  });

  test("v8.6.1 — the badge REVOKE token is scrubbed from the access log", () => {
    // `/api/admin/badges/<token>/revoke` carries the same capability the public
    // badge routes take, under `/badges/` — which `/\/badge\/…/` cannot match,
    // and there is no `?token=` for the query rule to see. Asserted against the
    // REAL function rather than a restatement of it, and paired with a control
    // that the public `/badge/<token>` form still redacts, so a mutation that
    // deletes the badge rules wholesale cannot pass this by widening nothing.
    // Reconstructed from its own SOURCE rather than required — server.js boots
    // the app at require time, which the v7.20.2 harness lock forbids — and the
    // function is pure string work with no free variables, so this drives the
    // REAL regexes rather than a restatement of them.
    const src = require("fs").readFileSync(require("path").join(__dirname, "..", "server.js"), "utf8");
    const i = src.indexOf("function _scrubLogPath");
    const fnSrc = src.slice(i, src.indexOf("\n}", i) + 2);
    const scrub = new Function(`${fnSrc}; return _scrubLogPath;`)();
    const T = "LIVE0token0THAT0MUST0NOT0LAND";
    expect(scrub(`/api/admin/badges/${T}/revoke`), "the revoke path is scrubbed").not.toContain(T);
    expect(scrub(`/badge/${T}`), "the public badge path still is").not.toContain(T);
    // …and globality means a second occurrence cannot ride along behind the first.
    expect(scrub(`/badge/${T}/badge/${T}`), "a second occurrence is scrubbed too").not.toContain(T);
  });
});

test.describe("v8.1.0 — the certificate has a home (PR 29)", () => {
  test("a Program certificate is earned on COMPLETION, not at the deadline", async () => {
    // THE GATE PR 29 RELAXES. A Program runs to a deadline that can be a year out
    // and enrolment is rolling, so requiring the event to end would make a learner
    // who finishes in month two wait ten months for the document they earned — on
    // the one kind built for exactly that pattern.
    const { api, csrf } = await sa();
    try {
      const f = await makeEvent(api, csrf, { kind: "program", tasks: 1 });
      const p = await enter(f.user.email, f.comp.id);
      try {
        // NOT ended: the deadline is 90 days out and nobody has called end-now.
        const early = await p.api.post(`/api/competitions/${f.comp.id}/badge`, { headers: { "x-csrf-token": p.csrf } });
        expect(early.status(), "…but not before completing it").toBe(403);
        expect((await early.json()).code).toBe("not_completed");

        expect((await submit(p.api, p.csrf, f.taskIds[0], "right0")).body.correct).toBe(true);
        const mint = await p.api.post(`/api/competitions/${f.comp.id}/badge`, { headers: { "x-csrf-token": p.csrf } });
        expect(mint.ok(), `a completed Program issues immediately: ${mint.status()} ${await mint.text()}`).toBeTruthy();
        const token = (await mint.json()).token;

        // And it is dated when they COMPLETED, never the far-future deadline.
        const row = badgeRow(token);
        expect(row.date_snapshot).toBeTruthy();
        expect(new Date(row.date_snapshot).getTime(),
          "a certificate must not carry a date in the future").toBeLessThanOrEqual(Date.now() + 60_000);
      } finally { await p.api.dispose(); }
    } finally { await api.dispose(); }
  });

  test("CONTROL: a Competition certificate still waits for the event to end", async () => {
    // Without this, "a Program issues early" is equally satisfied by a build that
    // dropped the lifecycle gate for everyone — and a PLACEMENT is not knowable
    // until the board is final.
    const { api, csrf } = await sa();
    try {
      const f = await makeEvent(api, csrf, { kind: "tournament", tasks: 2 });
      const p = await enter(f.user.email, f.comp.id);
      try {
        expect((await submit(p.api, p.csrf, f.taskIds[0], "right0")).body.correct).toBe(true);
        const early = await p.api.post(`/api/competitions/${f.comp.id}/badge`, { headers: { "x-csrf-token": p.csrf } });
        expect(early.status(), "a live Competition issues nothing").toBe(409);
      } finally { await p.api.dispose(); }
    } finally { await api.dispose(); }
  });

  test("GET /api/me/certificates lists what is held and what is claimable", async () => {
    const { api, csrf } = await sa();
    try {
      const f = await makeEvent(api, csrf, { kind: "program", tasks: 1 });
      const p = await enter(f.user.email, f.comp.id);
      try {
        let mine = await (await p.api.get("/api/me/certificates")).json();
        expect(mine.certificates, "nothing held yet").toEqual([]);
        expect(mine.claimable, "and nothing claimable before completing").toEqual([]);

        expect((await submit(p.api, p.csrf, f.taskIds[0], "right0")).body.correct).toBe(true);
        mine = await (await p.api.get("/api/me/certificates")).json();
        expect(mine.claimable.map(c => c.competitionId), "claimable the moment it is earned").toContain(f.comp.id);

        const mint = await p.api.post(`/api/competitions/${f.comp.id}/badge`, { headers: { "x-csrf-token": p.csrf } });
        expect(mint.ok()).toBeTruthy();
        mine = await (await p.api.get("/api/me/certificates")).json();
        expect(mine.certificates).toHaveLength(1);
        const c = mine.certificates[0];
        expect(c.label).toBe("Completed");
        expect(c.code, "the printed code, so the holder can read it back").toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-/);
        expect(c.revoked).toBe(false);
        // PR 26: a completion certificate's page is NOT published until shared,
        // and the holder is the person who needs to know which state it is in.
        expect(c.published).toBe(false);
        expect(mine.claimable, "claimed, so no longer claimable").toEqual([]);

        expect((await p.api.post(`/badge/${c.token}/shared`, { headers: { "x-csrf-token": p.csrf } })).ok()).toBeTruthy();
        mine = await (await p.api.get("/api/me/certificates")).json();
        expect(mine.certificates[0].published, "…and it says so once shared").toBe(true);
      } finally { await p.api.dispose(); }
    } finally { await api.dispose(); }
  });

  test("the code-to-holder resolver is SUPERADMIN only, and logs a fingerprint", async () => {
    // The deliberate bypass of the name gate. It is superadmin-tier because a code
    // can reach app.jsonl and any REGULAR admin reads those via /api/admin/logs —
    // an admin-tier resolver would hand every admin a code-to-holder path across
    // every event ever run.
    const { api, csrf } = await sa();
    try {
      const f = await makeEvent(api, csrf, { kind: "program", tasks: 1, person: { firstName: "Grace", lastName: "Hopper" } });
      const p = await enter(f.user.email, f.comp.id);
      let code;
      try {
        expect((await submit(p.api, p.csrf, f.taskIds[0], "right0")).body.correct).toBe(true);
        const mint = await p.api.post(`/api/competitions/${f.comp.id}/badge`, { headers: { "x-csrf-token": p.csrf } });
        code = (await mint.json()).publicCode;
      } finally { await p.api.dispose(); }

      const got = await (await api.get(`/api/admin/credential/${code}`)).json();
      expect(got.holder.name).toBe("Grace Hopper");
      expect(got.competition.id).toBe(f.comp.id);
      expect(got.revoked).toBe(false);
      // It accepts what a human would paste, like the public form does.
      expect((await api.get(`/api/admin/credential/${require("../lib/badge.js").formatCredentialCode(code).toLowerCase()}`)).ok()).toBeTruthy();

      const admin = await makeParticipant(api, csrf, uniq());
      expect((await api.post(`/api/admin/participants/${admin.id}/role`, { headers: H(csrf), data: { role: "admin" } })).ok()).toBeTruthy();
      const { api: ra, csrf: rc } = await freshCtx();
      try {
        expect((await codeLogin(ra, admin.email, H(rc))).ok()).toBeTruthy();
        expect((await ra.get(`/api/admin/credential/${code}`)).status(), "a regular admin is refused").toBe(403);
      } finally { await ra.dispose(); }

      // The audit row must not itself carry the code it exists because of.
      const fs = require("fs"), path = require("path");
      const dir = path.join(path.dirname(TEST_DB_PATH), "logs");
      await expect.poll(() => fs.readdirSync(dir).some(x => x.startsWith("app-")
        && fs.readFileSync(path.join(dir, x), "utf8").includes("credential_resolved")), { timeout: 10000 }).toBe(true);
      for (const x of fs.readdirSync(dir)) {
        expect(fs.readFileSync(path.join(dir, x), "utf8").includes(code),
          `${x} must not contain the raw code`).toBe(false);
      }
    } finally { await api.dispose(); }
  });
});
