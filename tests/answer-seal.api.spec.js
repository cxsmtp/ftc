// @ts-check
//
// v8.10.0 — THE SEALED ANSWER, on the wire.
//
// The promise this file pins: for a challenge created with `answer_sealed`, the
// answer key reaches exactly ONE human — the account named by
// `tasks.created_by_id` — and a submitted answer to it reaches the same one
// human. Not an event admin, not a global admin, not a superadmin, not a
// participant after the event's answer reveal, not a log reader, not a file on
// disk that anybody can download.
//
// ── HOW THIS FILE IS BUILT, AND WHY ──────────────────────────────────────────
//
// EVERY REDACTION CARRIES TWO CONTROLS, not one.
//
//  (a) An UNSEALED twin, created in the same breath by the same author with a
//      distinctive key of its own. "The superadmin could not see SEALKEY" is
//      equally satisfied by a build that shows nobody any answer anywhere — which
//      would be a far worse product than the leak — so every negative arm asserts
//      the twin's key IS still there in the same response.
//  (b) The AUTHOR, on the same request shape. "The answer is missing" is equally
//      satisfied by a build that dropped the column from the projection, which
//      would take the author's own edit form with it.
//
// ASSERTED BY VALUE, NEVER BY KEY. A `correct_answer` key can be renamed, folded
// into another field, or echoed under a different name, so the sharp arms serialise
// the WHOLE response and require the literal secret string to appear nowhere in it.
// That is what catches a leak arriving under a name nobody thought of — the
// structural-allow-list lesson from the v7.22.0 leak lock.
//
// THE SECRETS ARE DISTINCTIVE STRINGS. `SEALKEY_…`, `SEALWHY_…`, `PLAINKEY_…` are
// unique per run, so a whole-body substring search cannot collide with fixture
// noise and a failure names which secret escaped.
//
// THE AUTHOR IS A REAL ADMIN USER, NOT THE BUILT-IN SUPERADMIN. `actorId(req)` is
// `req.session.userId`, which the built-in account does not have — so it can author
// nothing, and a fixture built on it would make every ownership assertion vacuous.
// That is itself a tested property (`sealAtCreateDenied`), not an inconvenience.
const { test, expect } = require("./isolated-test");
// `freshCtx` rather than a direct `@playwright/test` import: a spec that requires
// that module gets NO per-file recycle hook and silently runs against whatever the
// previous file left behind (v7.20.0, and a scanner enforces it).
const { BASE, apiLogin, freshCtx, PARTICIPANT_PASS, gradingHashFor, codeLogin } = require("./helpers");
const { H, uniq, makeParticipant } = require("./event-admin-helpers");
const { TEST_DB_PATH } = require("./helpers");

// better-sqlite3 is opened INSIDE the callback, never at module scope: per-file
// isolation recreates the database in a `beforeAll`, so a handle taken at
// require time reads the previous file's unlinked inode (v7.20.2).
function withDb(fn, opts = { readonly: true }) {
  const Database = require("better-sqlite3");
  const db = new Database(TEST_DB_PATH, opts);
  try { return fn(db); } finally { db.close(); }
}

const iso = ms => new Date(Date.now() + ms).toISOString();

/** Promote a fresh participant to `admin` and sign in as them. */
async function makeAdmin(sa, saCsrf, label) {
  const p = await makeParticipant(sa, saCsrf, label);
  const r = await sa.post(`/api/admin/participants/${p.id}/role`, { headers: H(saCsrf), data: { role: "admin" } });
  expect(r.ok(), `promote ${label}: ${r.status()} ${await r.text()}`).toBeTruthy();
  const { api: ctx, csrf: c1 } = await freshCtx();
  const li = await codeLogin(ctx, p.email, H(c1));
  expect(li.ok(), `login ${label}: ${li.status()} ${await li.text()}`).toBeTruthy();
  const csrf = (await (await ctx.get("/api/csrf-token")).json()).csrfToken;
  return { ...p, api: ctx, csrf };
}

/** Two challenges by one author: one sealed, one not, with distinctive keys. */
async function makePair(owner, tag) {
  const mk = async (sealed) => {
    const r = await owner.api.post("/api/admin/tasks", {
      headers: H(owner.csrf),
      data: {
        title: uniq(sealed ? `Sealed ${tag}` : `Plain ${tag}`),
        description: "<p>d</p>", difficulty: "easy", answer_type: "text",
        correct_answer: sealed ? `SEALKEY_${tag}` : `PLAINKEY_${tag}`,
        explanation: sealed ? `<p>SEALWHY_${tag}</p>` : `<p>PLAINWHY_${tag}</p>`,
        status: "published",
        ...(sealed ? { answer_sealed: true } : {}),
      },
    });
    expect(r.ok(), `create ${sealed ? "sealed" : "plain"}: ${r.status()} ${await r.text()}`).toBeTruthy();
    return (await r.json()).id;
  };
  return { sealedId: await mk(true), plainId: await mk(false) };
}

let sa, saCsrf, author, other, TAG, sealedId, plainId;

test.beforeAll(async () => {
  ({ api: sa, csrf: saCsrf } = await apiLogin("superadmin"));
  author = await makeAdmin(sa, saCsrf, "sealauthor");
  other  = await makeAdmin(sa, saCsrf, "sealother");
  TAG = uniq("s").replace(/[^a-zA-Z0-9]/g, "");
  ({ sealedId, plainId } = await makePair(author, TAG));
});

test.afterAll(async () => {
  // The two admins are minted by this file, so nothing seeded needs restoring —
  // but the contexts hold live sessions and the platform allows one per user.
  await author?.api?.dispose();
  await other?.api?.dispose();
  await sa?.dispose();
});

test.describe("v8.10.0 — a sealed answer reaches its author and nobody else", () => {

  test("the admin challenge list withholds the key from every tier but the author, and says so", async () => {
    const rowsFor = async (c, label) => {
      const r = await c.get("/api/admin/tasks");
      expect(r.ok(), `${label} list: ${r.status()}`).toBeTruthy();
      const all = await r.json();
      const sealed = all.find(t => t.id === sealedId);
      const plain  = all.find(t => t.id === plainId);
      expect(sealed, `${label} can SEE the sealed challenge (visibility is not readability)`).toBeTruthy();
      expect(plain, `${label} can see the unsealed twin`).toBeTruthy();
      return { sealed, plain, raw: JSON.stringify(all) };
    };

    // THE AUTHOR — the control that stops "the answer is gone" passing for a
    // build that dropped the column outright and broke their own edit form.
    const mine = await rowsFor(author.api, "author");
    expect(mine.sealed.answer_sealed, "the row carries the flag").toBeTruthy();
    expect(mine.sealed.can_see_answer, "the author may read their own key").toBe(true);
    expect(mine.sealed.correct_answer, "the author's edit form is fed from this payload").toBe(`SEALKEY_${TAG}`);
    expect(mine.sealed.explanation).toContain(`SEALWHY_${TAG}`);
    expect(mine.sealed.can_edit, "the author may edit").toBe(true);

    for (const [c, label] of [[other.api, "another global admin"], [sa, "the superadmin"]]) {
      const got = await rowsFor(c, label);
      // BY VALUE over the whole payload: a leak under a renamed key still fails.
      expect(got.raw, `${label} must not receive the sealed key under ANY field name`).not.toContain(`SEALKEY_${TAG}`);
      expect(got.raw, `${label} must not receive the sealed explanation either`).not.toContain(`SEALWHY_${TAG}`);
      expect(got.sealed.correct_answer, "ABSENT, never blanked — an empty string is a real stored value for `any`").toBeUndefined();
      expect(got.sealed.explanation).toBeUndefined();
      expect(got.sealed.answer_sealed, "the flag itself is not a secret — the badge needs it").toBeTruthy();
      expect(got.sealed.can_see_answer, "the server states the answer, not the rule").toBe(false);
      expect(got.sealed.can_edit, "a sealed challenge is editable by its author alone").toBe(false);
      expect(got.sealed.can_edit_scoring, "the strict flag collapses with it").toBe(false);
      // CONTROL (a): the unsealed twin is untouched in the SAME response.
      expect(got.plain.correct_answer, `${label} still reads an ordinary challenge's key`).toBe(`PLAINKEY_${TAG}`);
      expect(got.plain.can_see_answer, "an unsealed row reports readable").toBe(true);
      expect(got.plain.can_edit, "and stays editable").toBe(true);
    }
  });

  test("only the author may edit, restore or recalculate — every other tier is refused, and nothing is written", async () => {
    const titleNow = async () => {
      const r = await author.api.get("/api/admin/tasks");
      return (await r.json()).find(t => t.id === sealedId).title;
    };
    const before = await titleNow();

    for (const [c, csrf, label] of [[other.api, other.csrf, "another global admin"], [sa, saCsrf, "the superadmin"]]) {
      const put = await c.put(`/api/admin/tasks/${sealedId}`, { headers: H(csrf), data: { title: `hijacked-${label}` } });
      expect(put.status(), `${label} PUT is refused`).toBe(403);
      expect((await put.json()).code).toBe("answer_sealed_not_author");
      // A 403 IS NOT A ROLLBACK: a build that refuses loudly and writes anyway is
      // byte-identical from the status alone (the v8.7.0 rule).
      expect(await titleNow(), `${label} wrote nothing`).toBe(before);

      const vs = await author.api.get(`/api/admin/tasks/${sealedId}/versions`);
      const versionId = (await vs.json()).slice(-1)[0].id;
      const res = await c.post(`/api/admin/tasks/${sealedId}/restore`, { headers: H(csrf), data: { versionId } });
      expect(res.status(), `${label} restore is refused`).toBe(403);
      expect((await res.json()).code).toBe("answer_sealed_not_author");
    }

    // Recalculate is superadmin-only, so the superadmin IS the reachable actor —
    // and the one whose `flipped` count would otherwise be a guess-and-confirm
    // oracle against a key they may not read.
    const rc = await sa.post(`/api/admin/tasks/${sealedId}/recalculate`, { headers: H(saCsrf), data: { confirm_live: true } });
    expect(rc.status(), "the superadmin cannot re-grade against a key they cannot read").toBe(403);
    expect((await rc.json()).code).toBe("answer_sealed_not_author");

    // CONTROL (b): the author can still do all three, so none of the above is a
    // build in which these routes simply stopped working.
    const mine = await author.api.put(`/api/admin/tasks/${sealedId}`, { headers: H(author.csrf), data: { title: `Sealed ${TAG} renamed` } });
    expect(mine.ok(), `the author may edit: ${mine.status()} ${await mine.text()}`).toBeTruthy();
    expect(await titleNow()).toBe(`Sealed ${TAG} renamed`);
    // CONTROL (a): an unsealed challenge by the same author stays open to others.
    const twin = await sa.put(`/api/admin/tasks/${plainId}`, { headers: H(saCsrf), data: { title: `Plain ${TAG} touched` } });
    expect(twin.ok(), "an unsealed challenge is still editable by a superadmin").toBeTruthy();
  });

  test("sealing is a ONE-WAY door: only the author may unseal, and nobody may re-seal", async () => {
    // 0 -> 1 after create is refused for EVERYONE, the author included. Between
    // creation and now the key has been on the wire to every admin, in
    // task_versions and in the tasks export; a column flip retrieves none of it.
    const p = await author.api.put(`/api/admin/tasks/${plainId}`, { headers: H(author.csrf), data: { answer_sealed: true } });
    expect(p.status(), "the author cannot seal an answer after the fact").toBe(403);
    expect((await p.json()).code).toBe("answer_seal_is_one_way");
    const still = await sa.get("/api/admin/tasks");
    expect((await still.json()).find(t => t.id === plainId).answer_sealed, "and nothing was written").toBeFalsy();

    // 1 -> 0 by a non-author is refused.
    const nope = await sa.put(`/api/admin/tasks/${sealedId}`, { headers: H(saCsrf), data: { answer_sealed: false } });
    expect(nope.status(), "a superadmin cannot unseal somebody else's answer").toBe(403);

    // ECHOING the stored value is NOT a change — a client round-tripping the whole
    // row must keep working (the `event_kind` rule).
    const echo = await author.api.put(`/api/admin/tasks/${sealedId}`, { headers: H(author.csrf), data: { answer_sealed: true, title: `Sealed ${TAG} echoed` } });
    expect(echo.ok(), `echoing the stored flag is not a change: ${echo.status()} ${await echo.text()}`).toBeTruthy();
  });

  // v8.10.1 — A SEAL PROTECTS A KEY, AND "ANY ANSWER (FREE RESPONSE)" HAS NONE.
  //
  // The pair is refused at three doors, and each assembles it differently: the
  // CREATE from one request, the PUT from the STORED flag plus the INCOMING
  // type, and the RESTORE from the live flag plus a SNAPSHOT's type. The matrix
  // below walks every answer type through the first two rather than asserting
  // the one that fails, so "the refusal fires" is separated from "it fires only
  // where it should" — a build that refused every seal would pass the first
  // half of each and fail the controls.
  const ALL_TYPES = ["text", "json", "file", "choice", "any"];
  const typeBody = (t) => {
    if (t === "choice") return { answer_type: "choice", choices: [{ text: "a", correct: true }, { text: "b", correct: false }] };
    if (t === "any")    return { answer_type: "any" };
    return { answer_type: t, correct_answer: `K_${t}_${TAG}` };
  };

  test("CREATE: every answer type may be sealed except the one with no answer", async () => {
    for (const t of ALL_TYPES) {
      const r = await author.api.post("/api/admin/tasks", {
        headers: H(author.csrf),
        data: { title: uniq(`SealType ${t} ${TAG}`), description: "<p>d</p>", difficulty: "easy",
                status: "published", answer_sealed: true, ...typeBody(t) },
      });
      if (t === "any") {
        expect(r.status(), `sealing an ${t} challenge is refused`).toBe(400);
        const b = await r.json();
        expect(b.code, "and names the reason, not a generic validation failure").toBe("answer_seal_needs_a_key");
        expect(b.error, "the refusal says what to do instead").toMatch(/another answer type|leave the answer unsealed/i);
      } else {
        expect(r.ok(), `CONTROL: ${t} may be sealed: ${r.status()} ${await r.text()}`).toBeTruthy();
      }
    }
  });

  test("CREATE: the free-response type is fine on its own — it is only the PAIR that is refused", async () => {
    for (const sealed of [false, true]) {
      const r = await author.api.post("/api/admin/tasks", {
        headers: H(author.csrf),
        data: { title: uniq(`AnyAlone ${sealed} ${TAG}`), description: "<p>d</p>", difficulty: "easy",
                status: "published", answer_type: "any", ...(sealed ? { answer_sealed: true } : {}) },
      });
      expect(r.status() === 200 || r.status() === 400, "one or the other").toBe(true);
      expect(r.ok(), `an UNSEALED any challenge is ordinary (sealed=${sealed})`).toBe(!sealed);
    }
  });

  test("PUT: a sealed challenge may be switched to any type but the keyless one, and an unsealed one to all of them", async () => {
    const mk = async (sealed, t) => {
      const r = await author.api.post("/api/admin/tasks", {
        headers: H(author.csrf),
        data: { title: uniq(`SealSwitch ${sealed}${t} ${TAG}`), description: "<p>d</p>", difficulty: "easy",
                status: "published", ...(sealed ? { answer_sealed: true } : {}), ...typeBody("text") },
      });
      expect(r.ok(), `create: ${r.status()} ${await r.text()}`).toBeTruthy();
      return (await r.json()).id;
    };
    for (const sealed of [true, false]) {
      for (const t of ALL_TYPES) {
        const id = await mk(sealed, t);
        const before = JSON.parse(await (await author.api.get("/api/admin/tasks")).text()).find(x => x.id === id);
        const put = await author.api.put(`/api/admin/tasks/${id}`, {
          headers: H(author.csrf),
          data: { title: before.title, difficulty: "easy", expectedUpdatedAt: before.updated_at, ...typeBody(t) },
        });
        const forbidden = sealed && t === "any";
        if (forbidden) {
          expect(put.status(), `sealed -> ${t} is refused`).toBe(400);
          expect((await put.json()).code).toBe("answer_seal_needs_a_key");
          // NOTHING MOVED: a refusal that had already written is worse than none.
          const after = JSON.parse(await (await author.api.get("/api/admin/tasks")).text()).find(x => x.id === id);
          expect(after.answer_type, "the stored type is untouched").toBe("text");
          expect(after.answer_sealed, "and it is still sealed").toBeTruthy();
        } else {
          expect(put.ok(), `CONTROL: sealed=${sealed} -> ${t}: ${put.status()} ${await put.text()}`).toBeTruthy();
        }
      }
    }
  });

  test("PUT: the two escapes from the pair are single saves that pass", async () => {
    // Unsealing and switching the type are both saves whose RESULT is legal, so
    // neither is caught by the refusal — a sealed challenge is never bricked.
    const r = await author.api.post("/api/admin/tasks", {
      headers: H(author.csrf),
      data: { title: uniq(`SealEscape ${TAG}`), description: "<p>d</p>", difficulty: "easy",
              status: "published", answer_sealed: true, ...typeBody("text") },
    });
    expect(r.ok(), `create: ${r.status()} ${await r.text()}`).toBeTruthy();
    const id = (await r.json()).id;
    const row = () => author.api.get("/api/admin/tasks").then(async x =>
      JSON.parse(await x.text()).find(t => t.id === id));

    // ESCAPE 1 — unseal, THEN switch. Both accepted, in that order.
    let b = await row();
    const un = await author.api.put(`/api/admin/tasks/${id}`, {
      headers: H(author.csrf),
      data: { title: b.title, difficulty: "easy", expectedUpdatedAt: b.updated_at, answer_sealed: false },
    });
    expect(un.ok(), `unseal: ${un.status()} ${await un.text()}`).toBeTruthy();
    b = await row();
    expect(b.answer_sealed, "it really unsealed").toBeFalsy();
    const sw = await author.api.put(`/api/admin/tasks/${id}`, {
      headers: H(author.csrf),
      data: { title: b.title, difficulty: "easy", expectedUpdatedAt: b.updated_at, answer_type: "any" },
    });
    expect(sw.ok(), `switch after unsealing: ${sw.status()} ${await sw.text()}`).toBeTruthy();
    expect((await row()).answer_type).toBe("any");
  });

  test("RESTORE: a snapshot of the keyless type cannot be replayed onto a sealed challenge", async () => {
    // THE SHARP CASE, and the only door that assembles the pair out of two
    // points in TIME: `answer_sealed` is deliberately not in the restore column
    // list (a snapshot predating the seal would otherwise unseal the challenge),
    // so the LIVE flag meets a SNAPSHOT's type.
    //
    // Under v8.10.1 the create and the PUT both refuse the pair, so a sealed
    // challenge can no longer acquire an `any` version by any route the API
    // offers — which is exactly why the state is manufactured here by writing
    // the flag straight into SQLite. That is the v8.10.0-era row this guard
    // exists for, and building it any other way would test the two doors already
    // covered above rather than this one.
    const mk = async (type) => {
      const r = await author.api.post("/api/admin/tasks", {
        headers: H(author.csrf),
        data: { title: uniq(`SealRestore ${type} ${TAG}`), description: "<p>d</p>", difficulty: "easy",
                status: "published", ...typeBody(type) },
      });
      expect(r.ok(), `create ${type}: ${r.status()} ${await r.text()}`).toBeTruthy();
      return (await r.json()).id;
    };
    const row = (id) => author.api.get("/api/admin/tasks").then(async x =>
      JSON.parse(await x.text()).find(t => t.id === id));
    const anyVersionOf = async (id) => {
      const raw = JSON.parse(await (await author.api.get(`/api/admin/tasks/${id}/versions`)).text());
      const list = raw.versions || raw;
      const v = list.find(x => {
        const snap = typeof x.snapshot === "string" ? JSON.parse(x.snapshot) : x.snapshot;
        return snap && snap.answer_type === "any";
      });
      expect(v, "the fixture really has an `any` version to restore").toBeTruthy();
      return v;
    };

    // Created UNSEALED as `any`, then moved to text — so `any` is history.
    const id = await mk("any");
    let b = await row(id);
    const sw = await author.api.put(`/api/admin/tasks/${id}`, {
      headers: H(author.csrf),
      data: { title: b.title, difficulty: "easy", expectedUpdatedAt: b.updated_at, ...typeBody("text") },
    });
    expect(sw.ok(), `switch to text: ${sw.status()} ${await sw.text()}`).toBeTruthy();
    const anyVer = await anyVersionOf(id);

    // CONTROL FIRST: while it is unsealed the restore is ordinary. Without this
    // the refusal below is satisfied by a build whose restore never works.
    const ok = await author.api.post(`/api/admin/tasks/${id}/restore`, {
      headers: H(author.csrf), data: { versionId: anyVer.id },
    });
    expect(ok.ok(), `CONTROL: an unsealed challenge restores its any version: ${ok.status()} ${await ok.text()}`).toBeTruthy();
    expect((await row(id)).answer_type, "and it really took").toBe("any");

    // Put it back on `text`, then SEAL IT BY HAND — the v8.10.0-era row.
    b = await row(id);
    const back = await author.api.put(`/api/admin/tasks/${id}`, {
      headers: H(author.csrf),
      data: { title: b.title, difficulty: "easy", expectedUpdatedAt: b.updated_at, ...typeBody("text") },
    });
    expect(back.ok(), `back to text: ${back.status()} ${await back.text()}`).toBeTruthy();
    withDb((db) => db.prepare("UPDATE tasks SET answer_sealed=1 WHERE id=?").run(id), { readonly: false });
    expect((await row(id)).answer_sealed, "the fixture really is sealed now").toBeTruthy();

    // THE ASSERTION: its OWN `any` version, refused, on the seal's own grounds.
    const bad = await author.api.post(`/api/admin/tasks/${id}/restore`, {
      headers: H(author.csrf), data: { versionId: anyVer.id },
    });
    expect(bad.status(), "restoring the keyless version onto a sealed challenge is refused").toBe(409);
    expect((await bad.json()).code, "and names the seal, not a corrupt snapshot").toBe("answer_seal_needs_a_key");
    const after = await row(id);
    expect(after.answer_type, "nothing moved").toBe("text");
    expect(after.answer_sealed, "and it is still sealed").toBeTruthy();
  });

  test("the built-in superadmin cannot seal, because a seal names an author and it has none", async () => {
    const r = await sa.post("/api/admin/tasks", {
      headers: H(saCsrf),
      data: { title: uniq("SA seal"), difficulty: "easy", answer_type: "text", correct_answer: "x", status: "published", answer_sealed: true },
    });
    expect(r.status(), "refused rather than creating a challenge no human could read or edit").toBe(400);
    expect((await r.json()).code).toBe("answer_seal_needs_author");
    // CONTROL: the same create WITHOUT the seal succeeds, so this is the seal
    // being refused and not the route.
    const ok = await sa.post("/api/admin/tasks", {
      headers: H(saCsrf),
      data: { title: uniq("SA plain"), difficulty: "easy", answer_type: "text", correct_answer: "x", status: "published" },
    });
    expect(ok.ok(), "the built-in superadmin may still create ordinary challenges").toBeTruthy();
  });

  test("the version history is sealed too — retroactively, over every snapshot", async () => {
    // The seal must reach snapshots written BEFORE the decision as well:
    // `task_versions` is exempt from retention, i.e. permanent, so a history
    // read backwards must not yield the key either.
    //
    // IT MAKES ITS OWN SECOND VERSION rather than relying on an edit an earlier
    // test happened to perform. That dependency is what made this fail when run
    // alone (measured), and it turned any earlier failure in the file into a
    // second, misleading one here — the same defect the Submissions arm below
    // had, found the same way, by a mutation killing two tests instead of one.
    {
      const before = JSON.parse(await (await author.api.get("/api/admin/tasks")).text())
        .find(t => t.id === sealedId);
      const bump = await author.api.put(`/api/admin/tasks/${sealedId}`, {
        headers: H(author.csrf),
        data: { title: `${before.title} v2`, difficulty: "easy", expectedUpdatedAt: before.updated_at },
      });
      expect(bump.ok(), `second version: ${bump.status()} ${await bump.text()}`).toBeTruthy();
    }
    const readAll = async (c, label) => {
      const r = await c.get(`/api/admin/tasks/${sealedId}/versions`);
      expect(r.ok(), `${label} may READ the history (visibility is unchanged)`).toBeTruthy();
      const body = await r.text();
      const snaps = JSON.parse(body).map(v => { try { return JSON.parse(v.snapshot); } catch { return {}; } });
      expect(snaps.length, "the fixture has produced several versions").toBeGreaterThan(1);
      return { body, snaps };
    };
    const mine = await readAll(author.api, "author");
    expect(mine.snaps.some(s => s.correct_answer === `SEALKEY_${TAG}`), "the author's own history still carries the key").toBeTruthy();

    for (const [c, label] of [[other.api, "another admin"], [sa, "the superadmin"]]) {
      const got = await readAll(c, label);
      expect(got.body, `${label} must not receive the key in ANY snapshot`).not.toContain(`SEALKEY_${TAG}`);
      expect(got.body, `${label} must not receive the explanation either`).not.toContain(`SEALWHY_${TAG}`);
      expect(got.snaps.every(s => !("correct_answer" in s)), "the field is deleted, not blanked").toBeTruthy();
      // CONTROL: the rest of the snapshot survives, so this is a redaction and
      // not an empty-history build.
      expect(got.snaps.every(s => typeof s.title === "string" && s.title.length), "every snapshot still carries its title").toBeTruthy();
    }

    // CONTROL (a): the UNSEALED twin's history is untouched for everyone.
    const plainHist = await sa.get(`/api/admin/tasks/${plainId}/versions`);
    expect(await plainHist.text(), "an ordinary challenge's history still shows its key").toContain(`PLAINKEY_${TAG}`);
  });

  test("the tasks export withholds the key from a non-author and carries the flag so the file explains itself", async () => {
    const exp = async (c, label) => {
      const r = await c.get("/api/admin/export/tasks");
      expect(r.ok(), `${label} export: ${r.status()}`).toBeTruthy();
      const body = await r.text();
      const rows = JSON.parse(body).tasks;
      return { body, sealed: rows.find(t => /^Sealed /.test(t.title)), plain: rows.find(t => /^Plain /.test(t.title)) };
    };
    const mine = await exp(author.api, "author");
    expect(mine.sealed.correct_answer, "the author can export their own sealed challenge in full").toBe(`SEALKEY_${TAG}`);
    expect(mine.sealed.answer_sealed, "and the file records that it was sealed").toBe(1);

    for (const [c, label] of [[other.api, "another admin"], [sa, "the superadmin"]]) {
      const got = await exp(c, label);
      expect(got.body, `${label}'s export file must not carry the key`).not.toContain(`SEALKEY_${TAG}`);
      expect(got.body, `${label}'s export file must not carry the explanation`).not.toContain(`SEALWHY_${TAG}`);
      // NULL rather than an omitted key: the drift guard requires every EXPORTED
      // column to reach the file, and the importer has to tell "withheld" from
      // "this format predates the field".
      expect(got.sealed.correct_answer, "present and null, so the file is well-formed").toBeNull();
      expect(got.sealed.answer_sealed, "and says WHY it is null").toBe(1);
      expect(got.plain.correct_answer, "CONTROL: the unsealed twin exports normally").toBe(`PLAINKEY_${TAG}`);
      expect(got.plain.answer_sealed).toBe(0);
    }
  });

  test("the importer refuses a sealed row rather than landing it unsealed or authorless, and counts it", async () => {
    const file = {
      type: "hackarena-tasks", version: 1,
      tasks: [
        { title: uniq("Imported sealed"), difficulty: "easy", answer_type: "text", correct_answer: "IMPKEY", answer_sealed: 1, status: "published" },
        { title: uniq("Imported plain"),  difficulty: "easy", answer_type: "text", correct_answer: "IMPKEY2", status: "published" },
      ],
    };
    const r = await sa.post("/api/admin/import/tasks", { headers: H(saCsrf), data: { data: file, resolutions: {} } });
    expect(r.ok(), `import: ${r.status()} ${await r.text()}`).toBeTruthy();
    const out = await r.json();
    // Refused because the import writes no `created_by_id` — landing it would
    // produce a sealed challenge with no author at all — and landing it UNSEALED
    // would silently break the promise the source platform made.
    expect(out.sealed_skipped, "the sealed row is refused and COUNTED, never silently dropped").toBe(1);
    expect(out.imported, "CONTROL: the unsealed row in the same file still lands").toBe(1);
    const list = await sa.get("/api/admin/tasks");
    const titles = (await list.json()).map(t => t.title);
    expect(titles.some(t => t === file.tasks[1].title), "the ordinary row is there").toBeTruthy();
    expect(titles.some(t => t === file.tasks[0].title), "the sealed row is not").toBeFalsy();
  });

  test("an OVERWRITE cannot rewrite a sealed challenge a non-author does not own", async () => {
    const t = await author.api.get("/api/admin/tasks");
    const sealedTitle = (await t.json()).find(x => x.id === sealedId).title;
    const r = await sa.post("/api/admin/import/tasks", {
      headers: H(saCsrf),
      data: {
        data: { type: "hackarena-tasks", version: 1,
                tasks: [{ title: sealedTitle, difficulty: "hard", answer_type: "text", correct_answer: "OVERWRITTEN", status: "published" }] },
        resolutions: { 0: "overwrite" },
      },
    });
    expect(r.ok(), `import: ${r.status()} ${await r.text()}`).toBeTruthy();
    expect((await r.json()).sealed_skipped, "refused and counted").toBe(1);
    // Read back AS THE AUTHOR — a redacted list would hide the damage from the
    // only actor who could see it.
    const after = await author.api.get("/api/admin/tasks");
    const row = (await after.json()).find(x => x.id === sealedId);
    expect(row.correct_answer, "the stored key is untouched").toBe(`SEALKEY_${TAG}`);
    expect(row.difficulty, "and so is everything else on the row").toBe("easy");
  });
});

test.describe("v8.10.0 — a sealed answer, and what participants and logs see", () => {
  let alice, bob, compId, sTask, pTask, LTAG;

  test.beforeAll(async () => {
    LTAG = uniq("L").replace(/[^a-zA-Z0-9]/g, "");
    // Two participants: the second never solves, so the all-solved auto-end
    // cannot end the event under the test (fixture-checklist item 1).
    alice = await makeParticipant(sa, saCsrf, "sealplayer");
    bob   = await makeParticipant(sa, saCsrf, "sealbystander");

    const comp = await author.api.post("/api/admin/competitions", {
      headers: H(author.csrf),
      data: { name: uniq("Seal Reveal"), start_time: iso(-60_000), duration_minutes: 60,
              event_kind: "tournament", reveal_answers_on_end: true },
    });
    expect(comp.ok(), `competition: ${comp.status()} ${await comp.text()}`).toBeTruthy();
    compId = (await comp.json()).competition.id;

    const pair = await makePair(author, LTAG);
    sTask = pair.sealedId; pTask = pair.plainId;
    for (const id of [sTask, pTask]) {
      const a = await author.api.post(`/api/admin/tasks/${id}/competitions`, { headers: H(author.csrf), data: { competitionIds: [compId] } });
      expect(a.ok(), `assign ${id}: ${a.status()} ${await a.text()}`).toBeTruthy();
    }
    const asg = await sa.post("/api/admin/competitions/assign", { headers: H(saCsrf), data: { userIds: [alice.id, bob.id], competitionIds: [compId] } });
    expect(asg.ok()).toBeTruthy();
    // The assign endpoint SKIPS an ineligible user and still answers 200, so the
    // count is asserted rather than the status (fixture-checklist item 7).
    expect((await asg.json()).assigned, "both participants really were enrolled").toBe(2);
  });

  test("a participant is never shown a sealed answer — not while playing, and not when the event reveals answers", async () => {
    const { api: ctx, csrf: _ctxCsrf } = await freshCtx();
    try {
      const c1 = _ctxCsrf;
      const li = await codeLogin(ctx, alice.email, H(c1));
      expect(li.ok(), `alice login: ${li.status()} ${await li.text()}`).toBeTruthy();
      const csrf = (await (await ctx.get("/api/csrf-token")).json()).csrfToken;
      const sel = await ctx.post("/api/select-competition", { headers: H(csrf), data: { competitionId: compId } });
      expect(sel.ok(), `select: ${sel.status()} ${await sel.text()}`).toBeTruthy();

      // She solves BOTH — so on the sealed one she is a solver, which is the
      // reader a naive implementation would hand the key back to.
      for (const [id, ans] of [[sTask, `SEALKEY_${LTAG}`], [pTask, `PLAINKEY_${LTAG}`]]) {
        const hash = await gradingHashFor(ctx, id);
        const s = await ctx.post(`/api/tasks/${id}/submit`, { headers: H(csrf), data: { answer: ans, gradingHash: hash } });
        expect(s.ok(), `submit ${id}: ${s.status()} ${await s.text()}`).toBeTruthy();
        expect((await s.json()).correct, "the fixture's answers really are correct").toBe(true);
      }

      const look = async (id) => {
        const r = await ctx.get(`/api/tasks/${id}`);
        expect(r.ok(), `task ${id}: ${r.status()}`).toBeTruthy();
        return { body: await r.text(), json: JSON.parse(await (await ctx.get(`/api/tasks/${id}`)).text()) };
      };

      // MID-EVENT: neither is revealed, so this arm alone proves nothing about
      // the seal — it is the precondition that makes the post-end arm meaningful.
      let s = await look(sTask);
      expect(s.body, "mid-event the sealed key is absent").not.toContain(`SEALKEY_${LTAG}`);
      expect(s.json.answer_sealed, "the participant is told the challenge is sealed").toBeTruthy();

      // END the event. `reveal_answers_on_end` is ON, so the twin's key WILL now
      // be published — which is exactly what makes the sealed one's absence mean
      // something rather than being satisfied by a build that reveals nothing.
      const end = await author.api.post(`/api/admin/competitions/${compId}/end-now`, { headers: H(author.csrf) });
      expect(end.ok(), `end-now: ${end.status()} ${await end.text()}`).toBeTruthy();

      const plain = await look(pTask);
      expect(plain.json.correct_answer, "CONTROL: an ordinary challenge IS revealed").toBe(`PLAINKEY_${LTAG}`);
      expect(plain.body, "including its explanation").toContain(`PLAINWHY_${LTAG}`);

      const sealed = await look(sTask);
      expect(sealed.body, "the sealed key is withheld from the reveal, by value").not.toContain(`SEALKEY_${LTAG}`);
      expect(sealed.body, "and so is the explanation, which in this threat model is the key wearing prose").not.toContain(`SEALWHY_${LTAG}`);
      expect(sealed.json.correct_answer).toBeUndefined();
      expect(sealed.json.explanation).toBeUndefined();
      // Withheld WITH its reason, so the client renders an explanation rather
      // than an empty Solution box (v7.14.2).
      expect(sealed.json.answer_sealed_withheld, "the server says WHY the reveal produced nothing").toBe(true);
      expect(plain.json.answer_sealed_withheld, "and says it only when it applies").toBeUndefined();
      // `created_by_id` is an internal user id and must never reach a participant.
      expect(sealed.json.created_by_id, "the author's user id is not on the participant wire").toBeUndefined();
    } finally { await ctx.dispose(); }
  });

  // v8.10.0 (found by an adversarial doc reviewer, not by review of the code):
  // the reveal is not the only thing a seal takes away from a participant.
  //
  // v7.20.1's SOLVER concession hands a participant who SOLVED a multiple-choice
  // challenge the correct option ids back, so the review view can mark them —
  // even in an event that reveals nothing. The seal removes that too. Without a
  // signal the participant meets plain unmarked options, no badge and no
  // explanation, on a challenge they got right: indistinguishable from the
  // platform having lost their answer. So the marker fires here as well, and the
  // panel's copy had to stop naming the reveal, which in this event never runs.
  test("a solver of a sealed multiple-choice challenge is told why nothing is marked, in an event that reveals nothing", async () => {
    // Its OWN competition: reveal_answers_on_end deliberately OFF, which is the
    // whole point of the case and the opposite of the fixture above.
    const cr = await author.api.post("/api/admin/competitions", {
      headers: H(author.csrf),
      data: { name: uniq("SealChoice"), start_time: iso(-60_000), duration_minutes: 600, timezone: "UTC", reveal_answers_on_end: false },
    });
    expect(cr.ok(), `comp: ${cr.status()} ${await cr.text()}`).toBeTruthy();
    const cId = (await cr.json()).competition.id;

    const mkChoice = async (sealed) => {
      const r = await author.api.post("/api/admin/tasks", {
        headers: H(author.csrf),
        data: {
          title: uniq(sealed ? `SealMC ${TAG}` : `PlainMC ${TAG}`),
          description: "<p>d</p>", difficulty: "easy", answer_type: "choice", status: "published",
          choices: [{ text: `RIGHT_${TAG}`, correct: true }, { text: `WRONG_${TAG}`, correct: false }],
          explanation: sealed ? `<p>MCWHY_${TAG}</p>` : `<p>PLAINMCWHY_${TAG}</p>`,
          ...(sealed ? { answer_sealed: true } : {}),
        },
      });
      expect(r.ok(), `create choice sealed=${sealed}: ${r.status()} ${await r.text()}`).toBeTruthy();
      const id = (await r.json()).id;
      const a = await author.api.post(`/api/admin/tasks/${id}/competitions`, { headers: H(author.csrf), data: { competitionIds: [cId] } });
      expect(a.ok(), `assign: ${a.status()} ${await a.text()}`).toBeTruthy();
      return id;
    };
    const mcSealed = await mkChoice(true);
    const mcPlain  = await mkChoice(false);

    const bob = await makeParticipant(sa, saCsrf, "sealmc");
    const asg = await sa.post("/api/admin/competitions/assign", {
      headers: H(saCsrf), data: { competitionIds: [cId], userIds: [bob.id] },
    });
    expect(asg.ok(), `assign participant: ${asg.status()} ${await asg.text()}`).toBeTruthy();
    expect((await asg.json()).assigned, "the assign really enrolled them — it SKIPS silently otherwise").toBe(1);

    const { api: ctx, csrf: c1 } = await freshCtx();
    try {
      const li = await codeLogin(ctx, bob.email, H(c1));
      expect(li.ok(), `bob login: ${li.status()} ${await li.text()}`).toBeTruthy();
      const csrf = (await (await ctx.get("/api/csrf-token")).json()).csrfToken;
      const sel = await ctx.post("/api/select-competition", { headers: H(csrf), data: { competitionId: cId } });
      expect(sel.ok(), `select: ${sel.status()} ${await sel.text()}`).toBeTruthy();

      // SOLVE BOTH. Solving is the precondition: the concession is a solver's.
      for (const id of [mcSealed, mcPlain]) {
        const det = JSON.parse(await (await ctx.get(`/api/tasks/${id}`)).text());
        const right = det.choices.find(c => c.text === `RIGHT_${TAG}`);
        expect(right, "the option text reaches the participant — the seal withholds correctness, not the question").toBeTruthy();
        const hash = await gradingHashFor(ctx, id);
        const sub = await ctx.post(`/api/tasks/${id}/submit`, {
          headers: H(csrf), data: { answer: JSON.stringify([right.id]), gradingHash: hash },
        });
        expect(sub.ok(), `submit ${id}: ${sub.status()} ${await sub.text()}`).toBeTruthy();
        expect((await sub.json()).correct, "the fixture really solves it").toBe(true);
      }

      const plain = JSON.parse(await (await ctx.get(`/api/tasks/${mcPlain}`)).text());
      // THE CONTROL, and it is what makes the assertion below mean anything: an
      // unsealed solved choice challenge still gets its ids back in this same
      // reveal-OFF event, so "the sealed one got none" is not satisfied by a
      // build that stopped sending them to anybody.
      expect(plain.correct_answer, "CONTROL: an unsealed solved choice challenge still marks its options").toBeTruthy();
      expect(plain.answer_sealed_withheld, "and says nothing, because nothing was taken from them").toBeUndefined();

      const sealedBody = await (await ctx.get(`/api/tasks/${mcSealed}`)).text();
      const sealedJson = JSON.parse(sealedBody);
      expect(sealedJson.correct_answer, "the sealed one marks nothing").toBeUndefined();
      expect(sealedBody, "and its explanation is withheld by value").not.toContain(`MCWHY_${TAG}`);
      expect(sealedJson.answer_sealed_withheld, "and the participant is TOLD why, rather than left with a blank review").toBe(true);
    } finally { await ctx.dispose(); }
  });

  // v8.10.0 — publish / hide / tag are edits in the operator's own words, the row
  // already withholds all three from a non-author (`can_edit` is false), and a
  // screen that hides a control the route would accept is the v7.14.2 defect with
  // the sides swapped: the next reader restores the button on the evidence that
  // the route works. Every arm carries the AUTHOR doing the same thing, or
  // "everyone is refused" is satisfied by a build that broke the routes.
  test("publish, hide and tag are refused on a sealed challenge for everyone but its author", async () => {
    const mk = async () => {
      const r = await author.api.post("/api/admin/tasks", {
        headers: H(author.csrf),
        data: {
          title: uniq(`SealGate ${TAG}`), description: "<p>d</p>", difficulty: "easy",
          answer_type: "text", correct_answer: `GATEKEY_${TAG}`, status: "draft", answer_sealed: true,
        },
      });
      expect(r.ok(), `create: ${r.status()} ${await r.text()}`).toBeTruthy();
      return (await r.json()).id;
    };
    const forOther = await mk();
    const forAuthor = await mk();

    const sealed403 = async (res, what) => {
      expect(res.status(), `${what} is refused`).toBe(403);
      expect((await res.json()).code, `${what} names the seal, not a tier`).toBe("answer_sealed_not_author");
    };

    // A SUPERADMIN, the tier that bypasses every other ownership rule on this row.
    await sealed403(await sa.post(`/api/admin/tasks/${forOther}/publish`, { headers: H(saCsrf) }), "publish");
    await sealed403(await sa.patch(`/api/admin/tasks/${forOther}/visibility`, { headers: H(saCsrf), data: { active: false } }), "hide");
    await sealed403(await sa.post(`/api/admin/tasks/${forOther}/tags`, { headers: H(saCsrf), data: { tag: `t${TAG}` } }), "tag-add");
    // A peer ADMIN, the ordinary case.
    await sealed403(await other.api.post(`/api/admin/tasks/${forOther}/publish`, { headers: H(other.csrf) }), "publish (peer admin)");

    // NOTHING MOVED — a 403 that had already written is worse than none.
    const row = JSON.parse(await (await author.api.get("/api/admin/tasks")).text())
      .find(t => t.id === forOther);
    expect(row.status, "still a draft").toBe("draft");
    expect(row.active, "still visible").toBeTruthy();
    expect(row.tags || [], "and untagged").toHaveLength(0);

    // THE CONTROL: the author does all four, on their own sealed challenge.
    for (const [res, what] of [
      [await author.api.post(`/api/admin/tasks/${forAuthor}/publish`, { headers: H(author.csrf) }), "publish"],
      [await author.api.patch(`/api/admin/tasks/${forAuthor}/visibility`, { headers: H(author.csrf), data: { active: false } }), "hide"],
      [await author.api.post(`/api/admin/tasks/${forAuthor}/tags`, { headers: H(author.csrf), data: { tag: `t${TAG}` } }), "tag-add"],
      [await author.api.delete(`/api/admin/tasks/${forAuthor}/tags/t${TAG}`, { headers: H(author.csrf) }), "tag-remove"],
    ]) {
      expect(res.ok(), `CONTROL: the author may ${what}: ${res.status()} ${await res.text()}`).toBeTruthy();
    }
  });

  // v8.10.0 — the import refuses a sealed row and counts it in `sealed_skipped`,
  // and those rows are deliberately NOT folded into `skipped`. So without a
  // consumer the operator's file loses rows with every number on screen
  // unchanged — the v7.21.2 defect on a counter whose absence cannot be
  // diagnosed from any screen. `_importDropNote` is module-private and the flow
  // needs a real file upload, so the consumer is pinned at SOURCE; the API half
  // (that the count exists at all) is behavioural, two tests above.
  test("the import's sealed-row refusal has a consumer on screen", async () => {
    const fs = require("fs");
    const src = fs.readFileSync(require("path").join(__dirname, "..", "public/js/features/export-import.js"), "utf8");
    const note = src.slice(src.indexOf("function _importDropNote"), src.indexOf("function _importDropNote") + 3000);
    expect(note, "_importDropNote renders sealed_skipped").toContain("sealed_skipped");
    // …and sealed_type_skipped (an overwrite that would make a sealed challenge an
    // Any answer), read by a live branch that puts the count into the summary: a
    // name that only survives in a dead branch would pass a bare substring check.
    expect(note, "_importDropNote renders sealed_type_skipped from a live branch").toMatch(/if\(d\.sealed_type_skipped\)bits\.push\(`\$\{d\.sealed_type_skipped\}/);
    // Anti-vacuity: the five siblings it sits beside must still be there, or a
    // rename has emptied this assertion and it passes against a gutted function.
    for (const k of ["invalid_timezones_dropped", "group_clashes_dropped", "invalid_roles_dropped", "fields_truncated"]) {
      expect(note, `the drop-note still renders ${k}`).toContain(k);
    }
  });

  test("the Submissions stream redacts a sealed answer, and the search box cannot confirm a guess", async () => {
    // ITS OWN COMPETITION, PAIR AND PLAYERS. An earlier draft read the describe's
    // shared `compId` and relied on the participant test above having submitted
    // into it — which made it fail when run alone (measured) and turned any
    // failure earlier in the file into a second, misleading failure here. A test
    // may not depend on another test having run (the standing independence rule);
    // and it cannot borrow this describe's fixture either, because that test ENDS
    // that competition, so a submission made here would be refused.
    const STAG = `S${LTAG}`;
    const comp = await author.api.post("/api/admin/competitions", {
      headers: H(author.csrf),
      data: { name: uniq("Seal Subs"), start_time: iso(-60_000), duration_minutes: 600, timezone: "UTC" },
    });
    expect(comp.ok(), `subs competition: ${comp.status()} ${await comp.text()}`).toBeTruthy();
    const subComp = (await comp.json()).competition.id;

    const { sealedId: subSealed, plainId: subPlain } = await makePair(author, STAG);
    for (const id of [subSealed, subPlain]) {
      const a = await author.api.post(`/api/admin/tasks/${id}/competitions`, { headers: H(author.csrf), data: { competitionIds: [subComp] } });
      expect(a.ok(), `assign ${id}: ${a.status()} ${await a.text()}`).toBeTruthy();
    }
    // A solver and a bystander: with only the solver enrolled, solving both would
    // trip the all-solved auto-end and close the event under the test
    // (fixture-checklist item 1).
    const solver    = await makeParticipant(sa, saCsrf, "sealsubs");
    const bystander = await makeParticipant(sa, saCsrf, "sealsubs2");
    const asg = await sa.post("/api/admin/competitions/assign", {
      headers: H(saCsrf), data: { userIds: [solver.id, bystander.id], competitionIds: [subComp] },
    });
    expect(asg.ok(), `assign players: ${asg.status()} ${await asg.text()}`).toBeTruthy();
    expect((await asg.json()).assigned, "the assign SKIPS silently, so the count is what proves it").toBe(2);

    const { api: pctx, csrf: pc1 } = await freshCtx();
    try {
      const li = await codeLogin(pctx, solver.email, H(pc1));
      expect(li.ok(), `solver login: ${li.status()} ${await li.text()}`).toBeTruthy();
      const pcsrf = (await (await pctx.get("/api/csrf-token")).json()).csrfToken;
      const sel = await pctx.post("/api/select-competition", { headers: H(pcsrf), data: { competitionId: subComp } });
      expect(sel.ok(), `select: ${sel.status()} ${await sel.text()}`).toBeTruthy();
      for (const [id, ans] of [[subSealed, `SEALKEY_${STAG}`], [subPlain, `PLAINKEY_${STAG}`]]) {
        const hash = await gradingHashFor(pctx, id);
        const sub = await pctx.post(`/api/tasks/${id}/submit`, { headers: H(pcsrf), data: { answer: ans, gradingHash: hash } });
        expect(sub.ok(), `submit ${id}: ${sub.status()} ${await sub.text()}`).toBeTruthy();
        expect((await sub.json()).correct, "the fixture's answers really are correct").toBe(true);
      }
    } finally { await pctx.dispose(); }

    const read = async (c, label, q) => {
      const url = `/api/admin/submissions?competitionId=${subComp}&limit=100` + (q ? `&q=${encodeURIComponent(q)}` : "");
      const r = await c.get(url);
      expect(r.ok(), `${label} submissions: ${r.status()}`).toBeTruthy();
      const body = await r.text();
      const json = JSON.parse(body);
      return { body, json, rows: json.events.filter(e => e.event_type === "submission") };
    };

    // THE AUTHOR — the control that stops every assertion below passing for a
    // build that stopped showing anybody any submitted answer.
    const mine = await read(author.api, "author");
    expect(mine.rows.length, "the fixture really produced submissions to read").toBe(2);
    expect(mine.body, "the author reads what was submitted to their own sealed challenge").toContain(`SEALKEY_${STAG}`);
    const mineSealed = mine.rows.find(e => e.answer === `SEALKEY_${STAG}`);
    expect(mineSealed.answer_sealed, "flagged, so the UI can badge it").toBe(true);
    expect(mineSealed.answer_visible).toBe(true);

    for (const [c, label] of [[other.api, "another admin"], [sa, "the superadmin"]]) {
      const got = await read(c, label);
      expect(got.body, `${label} must not read a submitted answer to a sealed challenge`).not.toContain(`SEALKEY_${STAG}`);
      // CONTROL: the unsealed twin's submitted answer is right there in the same
      // response, so this is a redaction rather than an empty stream.
      expect(got.body, `${label} still reads an ordinary submitted answer`).toContain(`PLAINKEY_${STAG}`);
      const sealedRow = got.rows.find(e => e.answer_sealed);
      expect(sealedRow, "the ROW is still there — the answer is withheld, not the event").toBeTruthy();
      expect(sealedRow.answer, "blanked").toBeNull();
      expect(sealedRow.answer_visible).toBe(false);
      expect(sealedRow.task_title, "and the challenge it belongs to is still named").toBeTruthy();
      // The projection columns that carry the DECISION must not ride the wire —
      // `_author` is an internal user id.
      expect(sealedRow._author, "the internal author column is stripped").toBeUndefined();
      expect(sealedRow._sealed).toBeUndefined();
    }

    // THE ORACLE. `#submissions-search` reaches a server-side LIKE over `answer`
    // and the pane renders a match COUNT, so without this an admin could type a
    // guessed key and be TOLD whether anybody had submitted it — confirming the
    // answer without it ever being painted. Redacting the cell alone leaves this
    // wide open, which is why it is asserted separately from the projection.
    const guess = await read(sa, "the superadmin", `SEALKEY_${STAG}`);
    expect(guess.rows.length, "a guessed sealed answer matches nothing for a non-author").toBe(0);
    expect(guess.json.total, "and the count agrees, so there is no oracle in the pager either").toBe(0);
    // CONTROL (a): the same search shape DOES work on an ordinary challenge, so
    // the zero above is a redaction rather than a broken search box.
    const ok = await read(sa, "the superadmin", `PLAINKEY_${STAG}`);
    expect(ok.rows.length, "an ordinary submitted answer is still searchable").toBe(1);
    // CONTROL (b): and it works for the AUTHOR on their own sealed challenge.
    const byAuthor = await read(author.api, "author", `SEALKEY_${STAG}`);
    expect(byAuthor.rows.length, "the author can still search their own sealed challenge").toBe(1);
  });

  test("nothing about a sealed challenge reaches the on-disk logs", async () => {
    const fs = require("fs"), path = require("path");
    const { TEST_DATA_DIR } = require("./helpers");
    // The author edits the key, which is the write that used to put BOTH values
    // into `changes.correct_answer` and from there into app.jsonl verbatim.
    //
    // A FRESH PAIR, deliberately: `sTask` / `pTask` are assigned to a competition
    // this file has already ENDED, and the scoring freeze correctly refuses a key
    // change there — so reusing them would fail for a reason that has nothing to
    // do with the seal.
    const { sealedId: logSealed, plainId: logPlain } = await makePair(author, `G${LTAG}`);
    const put = await author.api.put(`/api/admin/tasks/${logSealed}`, {
      headers: H(author.csrf), data: { correct_answer: `ROTATED_${LTAG}` },
    });
    expect(put.ok(), `key rotation: ${put.status()} ${await put.text()}`).toBeTruthy();

    // The audit mirror is `setImmediate`-deferred, so poll rather than sleep.
    const logDir = path.join(TEST_DATA_DIR, "logs");
    const readLogs = () => {
      if (!fs.existsSync(logDir)) return "";
      return fs.readdirSync(logDir).filter(f => f.endsWith(".jsonl"))
        .map(f => { try { return fs.readFileSync(path.join(logDir, f), "utf8"); } catch { return ""; } }).join("\n");
    };
    await expect.poll(() => readLogs().includes("sealed answer changed"), {
      message: "the edit is recorded — as a NOTE naming what changed, never as the two values",
      timeout: 10_000, intervals: [100, 200, 400, 800],
    }).toBe(true);

    const all = readLogs();
    for (const secret of [`SEALKEY_G${LTAG}`, `ROTATED_${LTAG}`, `SEALWHY_G${LTAG}`]) {
      expect(all.includes(secret), `"${secret}" must not appear anywhere on disk`).toBe(false);
    }
    // CONTROL: an ordinary challenge's key change IS recorded by value, so the
    // absence above is the seal and not a build that stopped auditing edits.
    const p2 = await author.api.put(`/api/admin/tasks/${logPlain}`, {
      headers: H(author.csrf), data: { correct_answer: `PLAINROT_${LTAG}` },
    });
    expect(p2.ok()).toBeTruthy();
    await expect.poll(() => readLogs().includes(`PLAINROT_${LTAG}`), {
      message: "an unsealed challenge's key change is still audited by value",
      timeout: 10_000, intervals: [100, 200, 400, 800],
    }).toBe(true);
  });

  test("the Submissions search term is scrubbed from the access log", async () => {
    // A participant's answer arrives in a POST body, which the access logger
    // never records — so the submit path is clean by construction. The search box
    // is the one place a real submitted answer reaches a URL, and from there
    // `access-*.jsonl`, which every regular admin reads through /api/admin/logs.
    const fs = require("fs"), path = require("path");
    const { TEST_DATA_DIR } = require("./helpers");
    const needle = `ACCESSLOGPROBE_${LTAG}`;
    const r = await sa.get(`/api/admin/submissions?competitionId=${compId}&q=${encodeURIComponent(needle)}`);
    expect(r.ok()).toBeTruthy();

    const logDir = path.join(TEST_DATA_DIR, "logs");
    const readAccess = () => fs.existsSync(logDir)
      ? fs.readdirSync(logDir).filter(f => f.startsWith("access-"))
          .map(f => fs.readFileSync(path.join(logDir, f), "utf8")).join("\n")
      : "";
    await expect.poll(() => readAccess().includes("/api/admin/submissions"), {
      message: "the request reached the access log at all — without this the assertion below is vacuous",
      timeout: 10_000, intervals: [100, 200, 400, 800],
    }).toBe(true);
    expect(readAccess().includes(needle), "the search term is scrubbed from the logged path").toBe(false);
    expect(readAccess()).toContain("q=[REDACTED]");
  });
});
