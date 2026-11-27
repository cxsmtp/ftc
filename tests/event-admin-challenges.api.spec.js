// @ts-check
//
// v8.7.0 — THE EVENT-ADMIN CHALLENGE SCOPE.
//
// The challenge bank is the one surface where an event admin's three separate
// answers genuinely differ, and conflating any two of them is a real hole:
//
//   SEE    — created by me, OR used by an event I run, OR public-domain
//   EDIT   — created by me. Owner only. VISIBLE IS NOT EDITABLE.
//   SCORE  — created by me AND every event holding it is one of mine (§9.1)
//   UNASSIGN — the event is mine AND *I* made that assignment (provenance)
//
// Every refusal below carries a GLOBAL-ADMIN CONTROL, because "the event admin
// was refused" is equally satisfied by a build that broke the route for
// everybody. Every positive list assertion carries a DECOY (`world.theirs` and
// the challenge assigned only to it), because "the list contains my challenge"
// is equally satisfied by a list that was never filtered at all.
//
// AND EVERY REFUSAL READS THE ROW BACK, because a 403 is not a rollback: a build
// that refuses loudly and writes anyway is byte-identical to a correct one from
// the status code alone. Measured, not assumed — moving the tag-add and the task
// PUT to write-then-403 leaves the ENTIRE file green except those read-backs.
// The mirror rule applies to the positive arms: a 200 is not a write either, so
// each one re-reads too (accept-and-ignore is a control that appears to work).
// Read back as the SUPERADMIN — a narrowed list would hide the damage from the
// very actor who did it.
//
// And the ZERO-GRANT actor is tested on BOTH narrowed lists — the challenge list
// and the tag VOCABULARY, the two surfaces `_taskVisibilitySql` is spliced into.
// `scopedCompetitionIds` returns `[]` for them, `IN ()` is a SQLite syntax error,
// so the naive `ids.length ? clause : ""` leaves the query UNFILTERED for exactly
// the actor who must see nothing. On this surface the fixture that separates a
// correct empty-scope implementation from one that drops the whole predicate is the
// public-domain challenge: it must SURVIVE the empty scope while everything else
// disappears.

const { test, expect } = require("./isolated-test");
const {
  H, uniq, makeTask, assignTask, buildWorld, expectRefused,
} = require("./event-admin-helpers");

const PUBLIC_DOMAIN = "public-domain";

/** The tasks list is a BARE ARRAY. Resolve one row from whichever actor asked. */
async function listTasks(api, query = "") {
  const r = await api.get(`/api/admin/tasks${query}`);
  expect(r.ok(), `GET /api/admin/tasks${query}: ${r.status()} ${await r.text()}`).toBeTruthy();
  const body = await r.json();
  expect(Array.isArray(body), "the admin tasks list answers a bare array").toBeTruthy();
  return body;
}

async function rowFor(api, taskId) {
  return (await listTasks(api)).find(t => t.id === taskId) || null;
}

/** Add a tag as an actor entitled to, asserting it took. */
async function addTag(api, csrf, taskId, tag) {
  const r = await api.post(`/api/admin/tasks/${taskId}/tags`, { headers: H(csrf), data: { tag } });
  expect(r.ok(), `tag ${tag}: ${r.status()} ${await r.text()}`).toBeTruthy();
  expect((await r.json()).tags, `tag ${tag} really landed`).toContain(tag);
}

test.describe("v8.7.0 — the event-admin challenge scope", () => {
  /** @type {any} */ let w;
  // The four visibility fixtures, built once and never mutated: every test that
  // writes owns a challenge of its own (the fixture checklist's rule), so a
  // failure here is about visibility and not about what ran before it.
  let mineOwn;      // (a) created BY the event admin
  let saInMine;     // (b) created by the superadmin, assigned to `mine`
  let saPublic;     // (c) created by the superadmin, tagged public-domain
  let decoy;        // (d) created by the superadmin, assigned to `theirs` ONLY

  test.beforeAll(async () => {
    test.setTimeout(180_000);
    // No seedTestData() — tests/isolated-test.js re-seeds before every spec FILE
    // and the seed is not idempotent (its fixed competition names 409).
    w = await buildWorld();

    mineOwn = await makeTask(w.eaApi, w.eaCsrf, "own");
    saInMine = await makeTask(w.sa, w.saCsrf, "inmine");
    await assignTask(w.sa, w.saCsrf, saInMine.id, [w.mine.id]);
    saPublic = await makeTask(w.sa, w.saCsrf, "public");
    await addTag(w.sa, w.saCsrf, saPublic.id, PUBLIC_DOMAIN);
    decoy = await makeTask(w.sa, w.saCsrf, "decoy");
    await assignTask(w.sa, w.saCsrf, decoy.id, [w.theirs.id]);
  });

  // ── VISIBILITY — the three-way rule ───────────────────────────────────────

  test("the challenge list is the three-way rule: created / used by my event / public-domain", async () => {
    const ids = (await listTasks(w.eaApi)).map(t => t.id);
    expect(ids, "(a) a challenge they created").toContain(mineOwn.id);
    expect(ids, "(b) a challenge used by an event they run").toContain(saInMine.id);
    expect(ids, "(c) a public-domain challenge").toContain(saPublic.id);
    // THE DECOY. Without it, an unfiltered list satisfies all three assertions
    // above and this test proves nothing at all.
    expect(ids, "(d) somebody else's challenge, in somebody else's event").not.toContain(decoy.id);

    // …and STRUCTURALLY: every row must be explained by one of the three arms.
    // A row-by-row invariant catches a widened predicate that happens to miss
    // the decoy, which a four-id matrix cannot.
    const rows = await listTasks(w.eaApi);
    for (const t of rows) {
      const explained =
        t.can_edit ||                                     // they created it
        (t.tags || []).includes(PUBLIC_DOMAIN) ||         // public-domain
        (t.competitions || []).some(c => c.id === w.mine.id); // used by their event
      expect(explained, `"${t.title}" is visible for no permitted reason`).toBeTruthy();
    }
    // The seeded bank exists and is owned by nobody, so it is the population the
    // structural check above is actually filtering — assert it is non-empty for
    // the superadmin, or "every row is explained" is vacuously true of a list
    // that only ever held this file's own rows.
    expect((await listTasks(w.sa)).length, "there IS a wider bank to be narrowed from")
      .toBeGreaterThan(rows.length);
  });

  test("THE CONTROL: a superadmin sees all four — the list is narrowed, not broken", async () => {
    const ids = (await listTasks(w.sa)).map(t => t.id);
    for (const [label, t] of [["a", mineOwn], ["b", saInMine], ["c", saPublic], ["d", decoy]]) {
      expect(ids, `(${label}) must be visible to an unscoped admin`).toContain(t.id);
    }
  });

  test("ZERO GRANTS sees ONLY the public-domain challenge — the empty-scope fail-open catcher", async () => {
    // `[]` is not `null`. If `_taskVisibilitySql` degraded its empty branch the
    // way `ids.length ? clause : ""` would, this actor would see the whole
    // platform's challenge bank. The public-domain arm is what makes this a
    // DISCRIMINATING fixture rather than "the list is empty": a build that
    // refused everything for a zero-grant actor would also pass an
    // all-absent assertion, and it would be wrong.
    const rows = await listTasks(w.zeroApi);
    const ids = rows.map(t => t.id);
    expect(ids, "the public-domain arm SURVIVES an empty scope").toContain(saPublic.id);
    expect(ids, "somebody else's challenge does not").not.toContain(mineOwn.id);
    expect(ids, "nor one used by an event they do not run").not.toContain(saInMine.id);
    expect(ids, "nor the decoy").not.toContain(decoy.id);

    // Structural: this actor created nothing, so EVERY row they see must be
    // public-domain. One dropped predicate and the seeded bank floods in.
    for (const t of rows) {
      expect((t.tags || []).includes(PUBLIC_DOMAIN),
        `zero-grant sees "${t.title}", which is not public-domain`).toBeTruthy();
    }
  });

  test("the tag VOCABULARY is narrowed by the same rule — the OTHER `_taskVisibilitySql` consumer", async () => {
    // `GET /api/admin/task-tags` feeds the Challenges filter chips, and it is the
    // SECOND surface spliced with `_taskVisibilitySql` — the module's own header
    // names both. Nothing in the suite exercised it as an event admin, so the arm
    // that narrows it was held by no test at all.
    //
    // It is the surface with NO named entity to fall back on. Everywhere else the
    // SQL mirror only has to be no WIDER than `taskViewDenied`, because the
    // predicate re-checks each row the actor then opens; here the answer IS the
    // list, and task tags are free text an admin types — ticket ids, customer
    // names, author names — so a dropped arm discloses somebody else's labels
    // with no second gate behind it.
    const mineTag = `ea-vocab-mine-${uniq("v")}`.toLowerCase().slice(0, 48);
    const decoyTag = `ea-vocab-decoy-${uniq("v")}`.toLowerCase().slice(0, 48);
    await addTag(w.eaApi, w.eaCsrf, mineOwn.id, mineTag);  // on a challenge they own
    await addTag(w.sa, w.saCsrf, decoy.id, decoyTag);      // on one they cannot see

    const vocabOf = async (api, who) => {
      const r = await api.get("/api/admin/task-tags");
      expect(r.ok(), `${who} task-tags: ${r.status()} ${await r.text()}`).toBeTruthy();
      const body = await r.json();
      expect(Array.isArray(body), `${who} task-tags answers a bare array`).toBeTruthy();
      return body;
    };

    const tags = await vocabOf(w.eaApi, "event admin");
    expect(tags, "a tag on a challenge they created").toContain(mineTag);
    expect(tags, "…and one on a challenge they can see").toContain(PUBLIC_DOMAIN);
    // THE DECOY. Without it an entirely unnarrowed vocabulary satisfies both
    // assertions above, which is exactly the shape this test exists to refuse.
    expect(tags, "a tag that exists ONLY on somebody else's challenge").not.toContain(decoyTag);

    // ZERO GRANTS — the empty-scope branch of the same helper, on the surface
    // where dropping the whole predicate is easiest to do by accident. The
    // public-domain arm must SURVIVE, or "the vocabulary is empty" would pass
    // here for a build that refuses this actor everything.
    const zTags = await vocabOf(w.zeroApi, "zero-grant");
    expect(zTags, "public-domain survives an empty scope here too").toContain(PUBLIC_DOMAIN);
    expect(zTags, "…but a tag on a challenge they neither own nor share does not").not.toContain(mineTag);
    expect(zTags, "…nor the decoy's").not.toContain(decoyTag);

    // CONTROL: an unscoped admin reads the whole vocabulary, so every absence
    // above is narrowing rather than a route that answers nothing to anybody.
    const all = await vocabOf(w.sa, "superadmin");
    for (const [label, tag] of [["the EA's own", mineTag], ["the decoy's", decoyTag], ["the public-domain", PUBLIC_DOMAIN]]) {
      expect(all, `CONTROL: a superadmin's vocabulary holds ${label} tag`).toContain(tag);
    }
    // …and the anti-vacuity floor: there IS a wider vocabulary to be narrowed
    // from, so the event admin's list is a strict subset rather than everything.
    expect(all.length, "the superadmin vocabulary is genuinely wider").toBeGreaterThan(tags.length);
  });

  test("?competitionId= naming an event they do not run is REFUSED, not answered empty", async () => {
    // An empty answer would be a probe: it lets an event admin enumerate which
    // challenges somebody else's event does NOT hold, one id at a time.
    const bad = await w.eaApi.get(`/api/admin/tasks?competitionId=${w.theirs.id}`);
    await expectRefused(bad, "the tasks list scoped to a foreign event", "event_admin_out_of_scope");

    const good = await listTasks(w.eaApi, `?competitionId=${w.mine.id}`);
    expect(good.map(t => t.id), "their own event's challenges ARE served").toContain(saInMine.id);

    // CONTROL: the same query still serves an unscoped admin.
    const ctl = await listTasks(w.sa, `?competitionId=${w.theirs.id}`);
    expect(ctl.map(t => t.id), "a superadmin reads the decoy event's challenges").toContain(decoy.id);
  });

  test("visibility governs the ANSWER KEY too — a version snapshot is the whole row", async () => {
    // The list is narrowed by `_taskVisibilitySql`, a deliberate SQL MIRROR of
    // `taskViewDenied`; this is the arm that pins the PREDICATE itself, on a
    // NAMED entity. It matters most here: `task_versions.snapshot` carries
    // `correct_answer`, so an unguarded route hands over the answer key of any
    // challenge whose id you can guess.
    const bad = await w.eaApi.get(`/api/admin/tasks/${decoy.id}/versions`);
    await expectRefused(bad, "reading a foreign challenge's history", "event_admin_out_of_scope");

    // The three visible arms all read, INCLUDING the public-domain one — which
    // is the pair that separates "visible" from "editable": they may read this
    // challenge's whole history and still not change a word of it.
    for (const [label, t] of [["their own", mineOwn], ["used by their event", saInMine], ["public-domain", saPublic]]) {
      const r = await w.eaApi.get(`/api/admin/tasks/${t.id}/versions`);
      expect(r.ok(), `reading the history of a ${label} challenge: ${r.status()}`).toBeTruthy();
      expect((await r.json()).length, `${label} has a history to read`).toBeGreaterThan(0);
    }

    // CONTROL: the route is not simply broken for the decoy.
    const ctl = await w.sa.get(`/api/admin/tasks/${decoy.id}/versions`);
    expect(ctl.ok(), `CONTROL: a superadmin reads it: ${ctl.status()}`).toBeTruthy();
  });

  // ── OWNERSHIP — visible does NOT mean editable ────────────────────────────

  test("editing is OWNER-ONLY: their own challenge saves, a shared one and a PUBLIC-DOMAIN one do not", async () => {
    const own = await makeTask(w.eaApi, w.eaCsrf, "put-own");

    const ok = await w.eaApi.put(`/api/admin/tasks/${own.id}`, {
      headers: H(w.eaCsrf), data: { title: `${own.title} edited` },
    });
    expect(ok.ok(), `owner edit: ${ok.status()} ${await ok.text()}`).toBeTruthy();
    // A 200 IS NOT A WRITE. Accept-and-ignore is a control that appears to work,
    // so the positive arm has to read the row back like every refusal below does.
    expect((await rowFor(w.sa, own.id)).title, "the owner's edit really persisted")
      .toBe(`${own.title} edited`);

    for (const [label, t] of [["used by their event", saInMine], ["PUBLIC-DOMAIN", saPublic]]) {
      const before = (await rowFor(w.sa, t.id)).title;
      const hijack = `hijacked ${Date.now()}`;
      const r = await w.eaApi.put(`/api/admin/tasks/${t.id}`, {
        headers: H(w.eaCsrf), data: { title: hijack },
      });
      await expectRefused(r, `editing a challenge ${label}`, "event_admin_not_owner");
      // …and the hijack really did not land. "The request was refused" is equally
      // satisfied by a build that refused loudly and saved anyway — the rule the
      // untag arm below already states, applied to the door that carries the
      // payload. Read back as the SUPERADMIN, or a narrowed list would hide the
      // damage from the very actor who did it.
      const afterRefusal = (await rowFor(w.sa, t.id)).title;
      expect(afterRefusal, `the ${label} title survived the refusal`).toBe(before);
      expect(afterRefusal, `…and is certainly not the hijack`).not.toBe(hijack);
      // (c) is the one worth spelling out: it is fully VISIBLE to this actor —
      // they may read it, assign it and see its versions — and still not theirs
      // to change. Visibility and editability are different questions.
      const c = await w.sa.put(`/api/admin/tasks/${t.id}`, {
        headers: H(w.saCsrf), data: { title: `${t.title} (sa)` },
      });
      expect(c.ok(), `CONTROL: a superadmin still edits the ${label} challenge: ${c.status()}`).toBeTruthy();
      // The control must WRITE, or it is satisfied by a route that 200s and does
      // nothing — which would make the refusals above unfalsifiable in the same way.
      expect((await rowFor(w.sa, t.id)).title, `CONTROL: the superadmin's edit landed on the ${label} challenge`)
        .toBe(`${t.title} (sa)`);
    }
  });

  test("publishing is owner-only — and the PERMISSION answer precedes the state answer", async () => {
    const draft = await makeTask(w.eaApi, w.eaCsrf, "draft-own", { status: "draft" });
    // Preconditions asserted, not assumed: a fixture that silently arrived
    // published would make the positive arm below a no-op that still 200s.
    expect((await rowFor(w.sa, draft.id)).status, "precondition: it really is a draft").toBe("draft");
    const pub = await w.eaApi.post(`/api/admin/tasks/${draft.id}/publish`, { headers: H(w.eaCsrf) });
    expect(pub.ok(), `publishing their own draft: ${pub.status()} ${await pub.text()}`).toBeTruthy();
    expect((await rowFor(w.sa, draft.id)).status, "…and the publish really took").toBe("published");

    // (b) and (c) are ALREADY published, so a route that asked "is it published?"
    // first would answer 400 and never reveal whether this actor may act at all.
    // The gate is deliberately ahead of that 400: a state answer about a row they
    // may not touch is itself a disclosure.
    for (const [label, t] of [["used by their event", saInMine], ["PUBLIC-DOMAIN", saPublic]]) {
      const r = await w.eaApi.post(`/api/admin/tasks/${t.id}/publish`, { headers: H(w.eaCsrf) });
      await expectRefused(r, `publishing a challenge ${label}`, "event_admin_not_owner");
    }
    // CONTROL: the superadmin meets the STATE answer on the same rows, which is
    // what proves the 403 above was about the actor and not about the route.
    const ctl = await w.sa.post(`/api/admin/tasks/${saInMine.id}/publish`, { headers: H(w.saCsrf) });
    expect(ctl.status(), "a superadmin reaches the already-published 400").toBe(400);
  });

  test("the visibility toggle is owner-only, and it is the OTHER DOOR onto `active`", async () => {
    // `active` is a scoring field, so this route takes the strict gate. For an
    // UNASSIGNED challenge the strict gate degrades to the owner rule, which is
    // the ordinary case and must keep working.
    const own = await makeTask(w.eaApi, w.eaCsrf, "vis-own");
    const before = (await rowFor(w.eaApi, own.id)).active;
    const ok = await w.eaApi.patch(`/api/admin/tasks/${own.id}/visibility`, { headers: H(w.eaCsrf) });
    expect(ok.ok(), `toggling their own challenge: ${ok.status()} ${await ok.text()}`).toBeTruthy();
    expect((await ok.json()).active, "the flip really happened").not.toBe(before);

    for (const [label, t] of [["used by their event", saInMine], ["PUBLIC-DOMAIN", saPublic]]) {
      const was = (await rowFor(w.sa, t.id)).active;
      const r = await w.eaApi.patch(`/api/admin/tasks/${t.id}/visibility`, { headers: H(w.eaCsrf) });
      await expectRefused(r, `hiding a challenge ${label}`, "event_admin_not_owner");
      // This route's whole job is to FLIP a column, so a refusal that flipped it
      // anyway is the one outcome a status-code assertion cannot see.
      expect((await rowFor(w.sa, t.id)).active, `the ${label} challenge is still as visible as it was`).toBe(was);
    }
    // CONTROL, and it is restored immediately so the visibility fixtures stay as
    // the earlier tests found them.
    const wasSa = (await rowFor(w.sa, saInMine.id)).active;
    const c = await w.sa.patch(`/api/admin/tasks/${saInMine.id}/visibility`, { headers: H(w.saCsrf) });
    expect(c.ok(), `CONTROL: a superadmin flips it: ${c.status()}`).toBeTruthy();
    expect((await rowFor(w.sa, saInMine.id)).active, "CONTROL: the superadmin's flip really happened").not.toBe(wasSa);
    // The restore is ASSERTED, or this test leaves a shared fixture hidden and the
    // next reader debugs the wrong file. An unchecked cleanup is not a cleanup.
    const undo = await w.sa.patch(`/api/admin/tasks/${saInMine.id}/visibility`, { headers: H(w.saCsrf) });
    expect(undo.ok(), `CONTROL restore: ${undo.status()}`).toBeTruthy();
    expect((await rowFor(w.sa, saInMine.id)).active, "the fixture is back as the earlier tests found it").toBe(wasSa);
  });

  test("tagging is owner-only — which is what stops an event admin publishing somebody else's challenge to everybody", async () => {
    const own = await makeTask(w.eaApi, w.eaCsrf, "tag-own");
    const tag = `ea-topic-${uniq("t").slice(0, 20)}`.toLowerCase();

    const add = await w.eaApi.post(`/api/admin/tasks/${own.id}/tags`, { headers: H(w.eaCsrf), data: { tag } });
    expect(add.ok(), `tagging their own: ${add.status()} ${await add.text()}`).toBeTruthy();
    expect((await add.json()).tags, "the tag landed").toContain(tag);

    const del = await w.eaApi.delete(
      `/api/admin/tasks/${own.id}/tags/${encodeURIComponent(tag)}`, { headers: H(w.eaCsrf) });
    expect(del.ok(), `untagging their own: ${del.status()}`).toBeTruthy();
    expect((await del.json()).tags, "the tag is gone").not.toContain(tag);

    for (const [label, t] of [["used by their event", saInMine], ["PUBLIC-DOMAIN", saPublic]]) {
      const a = await w.eaApi.post(`/api/admin/tasks/${t.id}/tags`, {
        headers: H(w.eaCsrf), data: { tag: "ea-should-not-stick" },
      });
      await expectRefused(a, `tagging a challenge ${label}`, "event_admin_not_owner");
      // The tag's NAME states the assertion that was missing: a refusal that wrote
      // the row anyway passes a status-code check and fails this one. The untag
      // half below already reads the row back; the add half must too, and it is
      // the sharper of the two here because a tag is how a challenge is SHARED.
      expect((await rowFor(w.sa, t.id)).tags, `nothing stuck to the ${label} challenge`)
        .not.toContain("ea-should-not-stick");
    }
    // The UNTAG is the sharper half: removing `public-domain` from a challenge
    // somebody else shared would take it away from every other event admin.
    const rm = await w.eaApi.delete(
      `/api/admin/tasks/${saPublic.id}/tags/${PUBLIC_DOMAIN}`, { headers: H(w.eaCsrf) });
    await expectRefused(rm, "removing public-domain from somebody else's challenge", "event_admin_not_owner");
    // …and it really is still tagged, or "the request was refused" is satisfied
    // by a build that refused loudly and deleted the row anyway.
    expect((await rowFor(w.sa, saPublic.id)).tags, "the tag survived the refusal").toContain(PUBLIC_DOMAIN);

    // CONTROL on both halves.
    const ct = await w.sa.post(`/api/admin/tasks/${saInMine.id}/tags`, {
      headers: H(w.saCsrf), data: { tag: "sa-control-tag" },
    });
    expect(ct.ok(), `CONTROL: a superadmin tags it: ${ct.status()}`).toBeTruthy();
    const cd = await w.sa.delete(`/api/admin/tasks/${saInMine.id}/tags/sa-control-tag`, { headers: H(w.saCsrf) });
    expect(cd.ok(), `CONTROL: a superadmin untags it: ${cd.status()}`).toBeTruthy();
  });

  // ── THE SCORING SPLIT (§9.1) ──────────────────────────────────────────────

  test.describe("the cross-scope scoring split", () => {
    /** @type {any} */ let shared;   // owned by the EA, ALSO in `theirs`
    /** @type {any} */ let solo;     // owned by the EA, in `mine` only — the CONTROL

    test.beforeAll(async () => {
      test.setTimeout(120_000);
      shared = await makeTask(w.eaApi, w.eaCsrf, "shared");
      await assignTask(w.eaApi, w.eaCsrf, shared.id, [w.mine.id]);
      // Only a global admin can put it in an event the EA does not run — which
      // is precisely the hole §9.1 closes: under a bare owner rule the EA could
      // then re-grade `theirs`.
      await assignTask(w.sa, w.saCsrf, shared.id, [w.theirs.id]);

      solo = await makeTask(w.eaApi, w.eaCsrf, "solo");
      await assignTask(w.eaApi, w.eaCsrf, solo.id, [w.mine.id]);

      // Preconditions, asserted rather than assumed: the two fixtures must
      // differ in exactly one respect, or the pair proves nothing.
      const sh = (await rowFor(w.sa, shared.id)).competitions.map(c => c.id).sort();
      expect(sh, "the shared challenge really is in BOTH events").toEqual([w.mine.id, w.theirs.id].sort());
      const so = (await rowFor(w.sa, solo.id)).competitions.map(c => c.id);
      expect(so, "the control challenge is in the EA's event ONLY").toEqual([w.mine.id]);
    });

    test("COSMETIC fields still save on a challenge somebody else's event also holds", async () => {
      const r = await w.eaApi.put(`/api/admin/tasks/${shared.id}`, {
        headers: H(w.eaCsrf),
        data: {
          title: `${shared.title} reworded`,
          description: "A clearer description.",
          hint: "A gentler hint.",
          explanation: "A fuller explanation.",
        },
      });
      expect(r.ok(), `cosmetic edit on a shared challenge: ${r.status()} ${await r.text()}`).toBeTruthy();
      expect((await rowFor(w.sa, shared.id)).title, "the cosmetic edit really persisted")
        .toBe(`${shared.title} reworded`);

      // …AND THE SHAPE THE REAL FORM SENDS. The admin editor posts
      // `correct_answer` and `difficulty` on every save, so a gate keyed on the
      // field being PRESENT rather than CHANGED would refuse a title typo fix on
      // every shared challenge (the v7.20.9 F3 trap, one gate over). Round-trip
      // the stored values unchanged and the save must still land.
      const cur = await rowFor(w.sa, shared.id);
      const round = await w.eaApi.put(`/api/admin/tasks/${shared.id}`, {
        headers: H(w.eaCsrf),
        data: {
          title: `${shared.title} reworded twice`,
          correct_answer: cur.correct_answer,
          difficulty: cur.difficulty,
          answer_type: cur.answer_type,
        },
      });
      expect(round.ok(),
        `an unchanged scoring round-trip must not be read as a scoring EDIT: ${round.status()} ${await round.text()}`
      ).toBeTruthy();
      expect((await rowFor(w.sa, shared.id)).title).toBe(`${shared.title} reworded twice`);
    });

    test("SCORING fields are refused, and the refusal NAMES the event they cannot manage", async () => {
      for (const [field, data] of [
        ["correct_answer", { correct_answer: "moved" }],
        ["difficulty", { difficulty: "hard" }],
        ["answer_type", { answer_type: "json" }],
      ]) {
        const r = await w.eaApi.put(`/api/admin/tasks/${shared.id}`, { headers: H(w.eaCsrf), data });
        const b = await expectRefused(r, `changing ${field} on a shared challenge`, "event_admin_scoring_locked");
        // A refusal an organiser cannot act on is the frozen-remedy defect: it
        // has to say WHICH event blocks it and who can help.
        expect(b.error, `the ${field} refusal names the offending event`).toContain(w.theirs.name);
        expect(b.error, `the ${field} refusal names the remedy`).toMatch(/administrator/i);
      }
      // Nothing moved.
      const row = await rowFor(w.sa, shared.id);
      expect(row.correct_answer, "the answer key is untouched").not.toBe("moved");
      expect(row.difficulty, "the difficulty is untouched").not.toBe("hard");
    });

    test("THE CONTROL: the same owner's challenge, in their event ONLY, accepts a scoring change", async () => {
      // Without this arm, "scoring is refused" is equally satisfied by a build
      // that refuses EVERY scoring edit from an event admin — which would make
      // the whole tier unable to author a challenge.
      const r = await w.eaApi.put(`/api/admin/tasks/${solo.id}`, {
        headers: H(w.eaCsrf), data: { correct_answer: "a-new-answer", difficulty: "medium" },
      });
      expect(r.ok(), `scoring edit on an in-scope challenge: ${r.status()} ${await r.text()}`).toBeTruthy();
      const row = await rowFor(w.sa, solo.id);
      expect(row.correct_answer, "the answer really moved").toBe("a-new-answer");
      expect(row.difficulty, "…and so did the difficulty").toBe("medium");
    });

    test("the OTHER doors onto a scoring field answer alike — visibility and restore", async () => {
      // Gating the PUT and not these would leave the refusal reachable-around by
      // REORDERING: refused `{active:0}` on the PUT, flip the same column here.
      const wasActive = (await rowFor(w.sa, shared.id)).active;
      const vis = await w.eaApi.patch(`/api/admin/tasks/${shared.id}/visibility`, { headers: H(w.eaCsrf) });
      await expectRefused(vis, "hiding a shared challenge", "event_admin_scoring_locked");
      // The refusal has to be a NON-EVENT, not merely a 403 over a completed flip:
      // `active` is the very column the reorder-around this test exists to close.
      expect((await rowFor(w.sa, shared.id)).active, "the shared challenge is still as visible as it was")
        .toBe(wasActive);

      // A restore rewrites the WHOLE row from a snapshot, so it is always a
      // scoring edit however innocent the operator's intent.
      const vers = await w.eaApi.get(`/api/admin/tasks/${shared.id}/versions`);
      expect(vers.ok(), "the owner may READ the history of their own challenge").toBeTruthy();
      const vId = (await vers.json())[0].id;
      const beforeRestore = await rowFor(w.sa, shared.id);
      const res = await w.eaApi.post(`/api/admin/tasks/${shared.id}/restore`, {
        headers: H(w.eaCsrf), data: { versionId: vId },
      });
      await expectRefused(res, "restoring a shared challenge", "event_admin_scoring_locked");
      // A restore that ran anyway would rewrite title AND answer key from the
      // snapshot, so both are read back — the refusal must have changed nothing.
      const afterRestore = await rowFor(w.sa, shared.id);
      expect(afterRestore.title, "the refused restore rewrote no title").toBe(beforeRestore.title);
      expect(afterRestore.correct_answer, "…and no answer key").toBe(beforeRestore.correct_answer);

      // CONTROL for both: a superadmin may still do either.
      const c1 = await w.sa.patch(`/api/admin/tasks/${shared.id}/visibility`, { headers: H(w.saCsrf) });
      expect(c1.ok(), `CONTROL: superadmin visibility flip: ${c1.status()}`).toBeTruthy();
      expect((await rowFor(w.sa, shared.id)).active, "CONTROL: the superadmin's flip really happened")
        .not.toBe(wasActive);
      const undo = await w.sa.patch(`/api/admin/tasks/${shared.id}/visibility`, { headers: H(w.saCsrf) });
      expect(undo.ok(), `CONTROL restore flip: ${undo.status()}`).toBeTruthy();
      const c2 = await w.sa.post(`/api/admin/tasks/${shared.id}/restore`, {
        headers: H(w.saCsrf), data: { versionId: vId },
      });
      expect(c2.ok(), `CONTROL: superadmin restore: ${c2.status()} ${await c2.text()}`).toBeTruthy();
    });
  });

  // ── ASSIGNMENT PROVENANCE ─────────────────────────────────────────────────

  test("an event admin may take back what THEY added, and nothing else", async () => {
    const own = await makeTask(w.eaApi, w.eaCsrf, "prov-own");
    await assignTask(w.eaApi, w.eaCsrf, own.id, [w.mine.id]);
    const mineRm = await w.eaApi.delete(
      `/api/admin/tasks/${own.id}/competitions/${w.mine.id}`, { headers: H(w.eaCsrf) });
    expect(mineRm.ok(), `removing their own assignment: ${mineRm.status()} ${await mineRm.text()}`).toBeTruthy();
    expect((await rowFor(w.sa, own.id)).competitions, "it really came out").toHaveLength(0);

    // The mirror: an assignment a GLOBAL admin made, on the SAME event, is not
    // theirs to undo. The bank is shared, so silently shrinking a challenge set
    // somebody else curated changes that event's all-solved denominator.
    const theirsDoing = await makeTask(w.sa, w.saCsrf, "prov-sa");
    await assignTask(w.sa, w.saCsrf, theirsDoing.id, [w.mine.id]);
    const refused = await w.eaApi.delete(
      `/api/admin/tasks/${theirsDoing.id}/competitions/${w.mine.id}`, { headers: H(w.eaCsrf) });
    await expectRefused(refused, "removing an assignment they did not make", "event_admin_not_assigner");
    expect((await rowFor(w.sa, theirsDoing.id)).competitions.map(c => c.id),
      "the assignment survived the refusal").toContain(w.mine.id);

    // CONTROL: the superadmin can still remove it — the route is not broken.
    const ctl = await w.sa.delete(
      `/api/admin/tasks/${theirsDoing.id}/competitions/${w.mine.id}`, { headers: H(w.saCsrf) });
    expect(ctl.ok(), `CONTROL: superadmin unassign: ${ctl.status()} ${await ctl.text()}`).toBeTruthy();
  });

  test("the desired-state sync refuses the WHOLE request when a removal is not theirs to make", async () => {
    // The client sends a DESIRED STATE, so quietly keeping a row it asked to drop
    // would answer 200 to a request the server did not carry out — and the dialog
    // would then render the old assignment as though nothing had been touched.
    const t = await makeTask(w.sa, w.saCsrf, "sync-sa");
    await assignTask(w.sa, w.saCsrf, t.id, [w.mine.id]);
    // Precondition: the EA can SEE it (rule b), so the refusal below is genuinely
    // about provenance and not about visibility.
    expect((await rowFor(w.eaApi, t.id)), "the EA can see the challenge under test").toBeTruthy();

    const r = await w.eaApi.put(`/api/admin/tasks/${t.id}/competitions`, {
      headers: H(w.eaCsrf),
      data: { competitionIds: [], expectedAssignments: [w.mine.id] },
    });
    await expectRefused(r, "syncing away an assignment they did not make", "event_admin_not_assigner");
    expect((await rowFor(w.sa, t.id)).competitions.map(c => c.id),
      "the whole request rolled back — the assignment is still there").toContain(w.mine.id);

    // The ADD arm of the same diff: naming an event they do not run.
    const own = await makeTask(w.eaApi, w.eaCsrf, "sync-add");
    const add = await w.eaApi.put(`/api/admin/tasks/${own.id}/competitions`, {
      headers: H(w.eaCsrf),
      data: { competitionIds: [w.theirs.id], expectedAssignments: [] },
    });
    await expectRefused(add, "syncing a challenge INTO a foreign event", "event_admin_out_of_scope");
    expect((await rowFor(w.sa, own.id)).competitions, "nothing was assigned").toHaveLength(0);

    // …and the ordinary in-scope sync still works, or "the sync refused" is
    // satisfied by a route that refuses every event admin outright.
    const ok = await w.eaApi.put(`/api/admin/tasks/${own.id}/competitions`, {
      headers: H(w.eaCsrf),
      data: { competitionIds: [w.mine.id], expectedAssignments: [] },
    });
    expect(ok.ok(), `an in-scope sync: ${ok.status()} ${await ok.text()}`).toBeTruthy();
    expect((await rowFor(w.sa, own.id)).competitions.map(c => c.id)).toContain(w.mine.id);

    // CONTROL: the superadmin's own desired-state sync on the refused challenge.
    const ctl = await w.sa.put(`/api/admin/tasks/${t.id}/competitions`, {
      headers: H(w.saCsrf), data: { competitionIds: [], expectedAssignments: [w.mine.id] },
    });
    expect(ctl.ok(), `CONTROL: superadmin sync: ${ctl.status()} ${await ctl.text()}`).toBeTruthy();
  });

  // ── ASSIGNMENT SCOPE ──────────────────────────────────────────────────────

  test("assigning INTO an event they do not run is refused — with the superadmin control", async () => {
    const own = await makeTask(w.eaApi, w.eaCsrf, "assign-own");
    const r = await w.eaApi.post(`/api/admin/tasks/${own.id}/competitions`, {
      headers: H(w.eaCsrf), data: { competitionIds: [w.theirs.id] },
    });
    await expectRefused(r, "assigning into a foreign event", "event_admin_out_of_scope");
    expect((await rowFor(w.sa, own.id)).competitions, "nothing was written").toHaveLength(0);

    // A MIXED batch is refused whole: this route is already all-or-nothing on
    // ended and unfit events, so a partial success would be the one outcome it
    // has never had.
    const mixed = await w.eaApi.post(`/api/admin/tasks/${own.id}/competitions`, {
      headers: H(w.eaCsrf), data: { competitionIds: [w.mine.id, w.theirs.id] },
    });
    await expectRefused(mixed, "a batch naming one foreign event", "event_admin_out_of_scope");
    expect((await rowFor(w.sa, own.id)).competitions,
      "the in-scope half was NOT assigned either").toHaveLength(0);

    // CONTROL: the in-scope half alone lands, and the superadmin can do the
    // whole thing — so the refusals above are about scope, not about the route.
    const good = await w.eaApi.post(`/api/admin/tasks/${own.id}/competitions`, {
      headers: H(w.eaCsrf), data: { competitionIds: [w.mine.id] },
    });
    expect(good.ok(), `assigning into their OWN event: ${good.status()} ${await good.text()}`).toBeTruthy();
    const ctl = await w.sa.post(`/api/admin/tasks/${own.id}/competitions`, {
      headers: H(w.saCsrf), data: { competitionIds: [w.theirs.id] },
    });
    expect(ctl.ok(), `CONTROL: superadmin assigns into the decoy event: ${ctl.status()}`).toBeTruthy();
  });

  test("the BULK assign reports its skip counters rather than throwing", async () => {
    // This route's whole posture is best-effort — one stale row must not sink a
    // 500-challenge assignment — so scope violations join the ledger instead of
    // becoming a 403. A counter with no consumer is the v7.21.2 defect, which is
    // why the counts are asserted by NAME.
    const own = await makeTask(w.eaApi, w.eaCsrf, "bulk-own");

    const foreign = await w.eaApi.post("/api/admin/tasks/assign-competitions", {
      headers: H(w.eaCsrf), data: { taskIds: [own.id], competitionIds: [w.theirs.id] },
    });
    expect(foreign.ok(), `bulk must not throw: ${foreign.status()} ${await foreign.text()}`).toBeTruthy();
    const fb = await foreign.json();
    expect(fb.assigned, "nothing landed").toBe(0);
    expect(fb.skipped.outOfScope, "the foreign event is counted as out of scope").toBe(1);

    // MIXED: the in-scope half really lands while the foreign half is skipped —
    // the arm that separates "best-effort" from "refuses everything".
    const mixed = await w.eaApi.post("/api/admin/tasks/assign-competitions", {
      headers: H(w.eaCsrf), data: { taskIds: [own.id], competitionIds: [w.mine.id, w.theirs.id] },
    });
    expect(mixed.ok(), `mixed bulk: ${mixed.status()} ${await mixed.text()}`).toBeTruthy();
    const mb = await mixed.json();
    expect(mb.assigned, "the in-scope half landed").toBe(1);
    expect(mb.skipped.outOfScope, "…and only the foreign half was skipped").toBe(1);
    expect((await rowFor(w.sa, own.id)).competitions.map(c => c.id),
      "and it landed in the RIGHT event").toEqual([w.mine.id]);

    // A challenge they may not even see is `notOwned`, not `notFound`: for an
    // event admin those two are one answer, or the ledger is an existence oracle.
    const unseen = await w.eaApi.post("/api/admin/tasks/assign-competitions", {
      headers: H(w.eaCsrf), data: { taskIds: [decoy.id], competitionIds: [w.mine.id] },
    });
    expect(unseen.ok(), `bulk with an invisible challenge: ${unseen.status()}`).toBeTruthy();
    const ub = await unseen.json();
    expect(ub.assigned, "somebody else's challenge does not land").toBe(0);
    expect(ub.skipped.notOwned, "…and is counted as notOwned").toBe(1);
    expect(ub.skipped.notFound, "…never as notFound, which would confirm the id exists").toBe(0);

    // CONTROL: the superadmin's identical batch assigns the decoy for real, so
    // "nothing landed" above is about the actor and not about the batch.
    const ctl = await w.sa.post("/api/admin/tasks/assign-competitions", {
      headers: H(w.saCsrf), data: { taskIds: [decoy.id], competitionIds: [w.mine.id] },
    });
    expect(ctl.ok(), `CONTROL: superadmin bulk: ${ctl.status()}`).toBeTruthy();
    expect((await ctl.json()).assigned, "a superadmin's batch really assigns").toBe(1);
    // ASSERTED cleanup. That control put the DECOY into the event admin's own
    // event, which is the one thing that would make it visible to them — so a
    // silently-failed undo turns this file's central decoy into a fixture that
    // proves nothing, in whichever test runs next. An unchecked cleanup is not a
    // cleanup (v8.3.29: the one that could never have worked went unnoticed for
    // as long as nobody read its response).
    const undo = await w.sa.delete(
      `/api/admin/tasks/${decoy.id}/competitions/${w.mine.id}`, { headers: H(w.saCsrf) });
    expect(undo.ok(), `cleanup: the decoy must come back OUT of the EA's event: ${undo.status()}`).toBeTruthy();
    expect((await rowFor(w.sa, decoy.id)).competitions.map(c => c.id),
      "the decoy is out of the EA's event again").not.toContain(w.mine.id);
    expect((await listTasks(w.eaApi)).map(t => t.id),
      "…and is invisible to the event admin once more").not.toContain(decoy.id);
  });

  // ── RESTORE MUST NOT TRANSFER OWNERSHIP ───────────────────────────────────

  test("a superadmin's RESTORE does not transfer ownership of the challenge", async () => {
    // `task_versions` snapshots the whole row, so a snapshot written since
    // v8.7.0 CARRIES `created_by_id`; the restore UPDATE's hand-maintained
    // column list deliberately omits it. Restore rewrites CONTENT — who owns a
    // challenge is not content.
    //
    // Scoped honestly: this kills the plausible wrong implementation, which is
    // that the RESTORER becomes the owner (the built-in superadmin owns nothing,
    // so the event admin would lose the challenge outright). It cannot see a
    // restore that writes `s.created_by_id`, because no route ever moves that
    // column, so every reachable snapshot already carries the current owner.
    const own = await makeTask(w.eaApi, w.eaCsrf, "restore-own");
    const edited = `${own.title} v2`;
    const ed = await w.eaApi.put(`/api/admin/tasks/${own.id}`, {
      headers: H(w.eaCsrf), data: { title: edited },
    });
    expect(ed.ok(), `owner edit before restore: ${ed.status()} ${await ed.text()}`).toBeTruthy();

    const vers = await w.sa.get(`/api/admin/tasks/${own.id}/versions`);
    expect(vers.ok(), `versions: ${vers.status()}`).toBeTruthy();
    const list = await vers.json();
    expect(list.length, "the edit really produced a second version").toBeGreaterThan(1);
    const oldest = list[list.length - 1];

    const r = await w.sa.post(`/api/admin/tasks/${own.id}/restore`, {
      headers: H(w.saCsrf), data: { versionId: oldest.id },
    });
    expect(r.ok(), `superadmin restore: ${r.status()} ${await r.text()}`).toBeTruthy();
    // Precondition for the claim below: the restore really did rewrite the row.
    expect((await rowFor(w.sa, own.id)).title, "the restore moved the content back").toBe(own.title);

    // `created_by_id` is not on the wire (it is an internal user id), so the
    // observable is the flag the client renders its offer from — and, better, an
    // edit that actually succeeds.
    const row = await rowFor(w.eaApi, own.id);
    expect(row, "the creator can still SEE their challenge after somebody else restored it").toBeTruthy();
    expect(row.can_edit, "…and still owns it").toBe(true);
    const after = await w.eaApi.put(`/api/admin/tasks/${own.id}`, {
      headers: H(w.eaCsrf), data: { title: `${own.title} v3` },
    });
    expect(after.ok(), `the creator can still edit after the restore: ${after.status()}`).toBeTruthy();
  });

  // ── THE WIRE FLAGS ────────────────────────────────────────────────────────

  test("the row carries the ANSWER, not the rule: can_edit / can_edit_scoring / can_unassign", async () => {
    // The client cannot see `created_by_id`, so a second copy of a three-part
    // rule would be one edit away from offering a control the server refuses.
    // These flags come from the SAME predicates the write routes enforce, so
    // this test is what keeps the offer and the outcome in step.
    const own = await makeTask(w.eaApi, w.eaCsrf, "flags-own");
    await assignTask(w.eaApi, w.eaCsrf, own.id, [w.mine.id]);   // assigned BY the EA
    await assignTask(w.sa, w.saCsrf, own.id, [w.theirs.id]);    // …and by a global admin

    const row = await rowFor(w.eaApi, own.id);
    expect(row, "their own challenge is in their list").toBeTruthy();
    expect(row.can_edit, "they own it, so cosmetic edits are offered").toBe(true);
    expect(row.can_edit_scoring,
      "…but another admin's event holds it, so scoring is NOT offered").toBe(false);
    const byId = Object.fromEntries((row.competitions || []).map(c => [c.id, c]));
    expect(byId[w.mine.id].can_unassign, "they added it to their own event").toBe(true);
    // v8.8.8 — RE-POINTED, and this arm is where the leak was pinned as correct.
    //
    // It used to read `can_unassign === false` for the OUT-OF-SCOPE event, which
    // meant the suite knew the array named another organiser's event and asserted
    // that as intended (v8.7.7 said so when it found the projection unfiltered).
    // The entry is simply not there now, which states the same rule more
    // strongly: not "you may not remove it" but "it was never offered".
    expect(byId[w.theirs.id], "the other organiser's event is not on the row at all").toBeUndefined();
    // CONTROL: withheld, not dropped — the assignment still exists.
    const asSa = await rowFor(w.sa, own.id);
    expect((asSa.competitions || []).map(c => c.id).sort(),
      "…and a global admin still sees both").toEqual([w.mine.id, w.theirs.id].sort());

    // …and the PROVENANCE arm on its own. The scope arm above can no longer
    // stand in for it at all — that entry is gone rather than flagged — so this
    // row, inside their own event and still not theirs to remove, is the only
    // shape that pins provenance.
    const curated = await makeTask(w.sa, w.saCsrf, "flags-curated");
    await assignTask(w.sa, w.saCsrf, curated.id, [w.mine.id]);
    const cRow = await rowFor(w.eaApi, curated.id);
    expect(cRow, "a challenge a global admin put in their event IS visible").toBeTruthy();
    const cMine = (cRow.competitions || []).find(c => c.id === w.mine.id);
    expect(cMine.can_unassign,
      "in THEIR event, but assigned by somebody else — not theirs to remove").toBe(false);

    // The flags must AGREE with the routes, which is the whole point of shipping
    // them: an offered control that 403s is the defect they exist to prevent.
    const scoring = await w.eaApi.put(`/api/admin/tasks/${own.id}`, {
      headers: H(w.eaCsrf), data: { correct_answer: "nope" },
    });
    await expectRefused(scoring, "the route agrees with can_edit_scoring:false", "event_admin_scoring_locked");
    expect((await rowFor(w.sa, own.id)).correct_answer, "…and the answer key did not move")
      .not.toBe("nope");
    const cosmetic = await w.eaApi.put(`/api/admin/tasks/${own.id}`, {
      headers: H(w.eaCsrf), data: { title: `${own.title} ok` },
    });
    expect(cosmetic.ok(), "the route agrees with can_edit:true").toBeTruthy();
    expect((await rowFor(w.sa, own.id)).title, "…and can_edit:true means the write really lands")
      .toBe(`${own.title} ok`);

    // A challenge they can SEE but not own carries the flags DOWN — the arm that
    // stops "every flag is true" passing this test.
    const shared = await rowFor(w.eaApi, saPublic.id);
    expect(shared.can_edit, "a public-domain challenge is visible, not editable").toBe(false);
    expect(shared.can_edit_scoring, "…and certainly not scorable").toBe(false);

    // CONTROL: for an unscoped admin every flag is true, so a build that simply
    // hard-coded `false` fails here.
    const saRow = await rowFor(w.sa, own.id);
    expect(saRow.can_edit, "superadmin: can_edit").toBe(true);
    expect(saRow.can_edit_scoring, "superadmin: can_edit_scoring").toBe(true);
    // …over a non-empty array. A `for` over `[]` asserts nothing, and this row is
    // deliberately in TWO events, which is what the loop is here to walk.
    expect(saRow.competitions.map(c => c.id).sort(), "CONTROL: the superadmin sees BOTH holdings")
      .toEqual([w.mine.id, w.theirs.id].sort());
    for (const c of saRow.competitions) {
      expect(c.can_unassign, `superadmin: can_unassign on ${c.name}`).toBe(true);
    }
  });
});
