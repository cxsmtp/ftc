// @ts-check
//
// v7.21.0 — challenge CATEGORIES.
//
// A category is not a new column or a new admin surface: it is an ordinary task
// tag following the convention `category:<name>`. Nothing about the tag is
// special until it is READ — and WHERE it is read is the whole feature, because
// a `category:` tag is the ONLY task tag a participant ever sees.
//
// That is the security property this file exists to pin. Task tags are
// free-text admin labels: real instances carry `needs-review`, author names,
// ticket ids, "too-easy", "reuse-2024". Shipping the raw tag list to
// participants would leak all of it, so both participant endpoints
// (`GET /api/tasks`, `GET /api/tasks/:id`) return a parsed `categories` array
// of NAMES and never the tags themselves.
//
// The load-bearing assertion is therefore NOT "categories is right" — a build
// that returned every tag verbatim would still satisfy that for a challenge
// carrying only category tags. It is that a plain admin tag appears NOWHERE in
// the serialised participant payload, with the admin endpoint returning that
// same tag as the POSITIVE CONTROL so the test cannot pass because the tag was
// never created in the first place.
const { test, expect } = require("./isolated-test");
const { apiLogin, BASE, PARTICIPANT_PASS } = require("./helpers");

test.use({ baseURL: BASE });

const H = (csrf) => ({ "x-csrf-token": csrf, "content-type": "application/json" });

/** A stamp unique per call, so a tag string can be searched for across a whole payload. */
const stamp = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

/**
 * Create a published challenge, assign it to the seed's live competition, and
 * apply `tags` through the REAL admin tag endpoint (not a direct INSERT) — the
 * lowercasing and trimming that endpoint performs are part of what the edge
 * cases below are asserting.
 *
 * Returns the task id, the competition id and the tag list the ADMIN sees,
 * which is the positive control for the leak assertions.
 */
async function seedTaggedChallenge(sa, saCsrf, tags) {
  const comps = await (await sa.get("/api/admin/competitions")).json();
  const live = (comps.competitions || comps).find((c) => c.name === "Test Live");
  expect(live, "the seed's live competition must exist").toBeTruthy();

  const s = stamp();
  const cr = await sa.post("/api/admin/tasks", {
    headers: H(saCsrf),
    data: {
      title: `Cat ${s}`, description: `<p>Challenge ${s}</p>`,
      difficulty: "easy", answer_type: "text", correct_answer: `answer-${s}`,
      status: "published",
    },
  });
  expect(cr.ok(), `create task: ${cr.status()} ${await cr.text()}`).toBeTruthy();
  const taskId = (await cr.json()).id;

  const asg = await sa.post(`/api/admin/tasks/${taskId}/competitions`, {
    headers: H(saCsrf), data: { competitionIds: [live.id] },
  });
  expect(asg.ok(), `assign to live: ${asg.status()} ${await asg.text()}`).toBeTruthy();

  let adminTags = [];
  for (const tag of tags) {
    const tr = await sa.post(`/api/admin/tasks/${taskId}/tags`, { headers: H(saCsrf), data: { tag } });
    expect(tr.ok(), `tag ${JSON.stringify(tag)}: ${tr.status()} ${await tr.text()}`).toBeTruthy();
    adminTags = (await tr.json()).tags;
  }
  return { taskId, compId: live.id, adminTags };
}

/**
 * Read a challenge as a participant, through BOTH endpoints, in one call.
 * `list` is the challenge's own entry in `GET /api/tasks`; `listBody` and
 * `detailBody` are the FULL payloads, which is what the leak assertions walk.
 */
async function readAsParticipant(compId, taskId) {
  const { api, csrf } = await apiLogin("alice@acme.com", PARTICIPANT_PASS);
  const sel = await api.post("/api/select-competition", { headers: H(csrf), data: { competitionId: compId } });
  expect(sel.ok(), `select-competition: ${sel.status()} ${await sel.text()}`).toBeTruthy();

  const lr = await api.get("/api/tasks");
  expect(lr.ok(), `GET /api/tasks: ${lr.status()} ${await lr.text()}`).toBeTruthy();
  const listBody = await lr.json();

  const dr = await api.get(`/api/tasks/${taskId}`);
  expect(dr.ok(), `GET /api/tasks/${taskId}: ${dr.status()} ${await dr.text()}`).toBeTruthy();
  const detailBody = await dr.json();

  await api.dispose();
  const list = listBody.find((t) => t.id === taskId);
  expect(list, "the seeded challenge must appear in the participant's list").toBeTruthy();
  return { list, listBody, detailBody };
}

test.describe("Challenge categories — the participant API contract (v7.21.0)", () => {
  test("a `category:` tag is exposed as a category NAME on both participant endpoints", async () => {
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const { taskId, compId, adminTags } = await seedTaggedChallenge(sa, saCsrf, ["category:web"]);
    // Positive control: the tag really was created, in the shape the parse expects.
    expect(adminTags).toEqual(["category:web"]);
    await sa.dispose();

    const { list, detailBody } = await readAsParticipant(compId, taskId);
    expect(list.categories, "GET /api/tasks must carry the parsed category name").toEqual(["web"]);
    expect(detailBody.categories, "GET /api/tasks/:id must carry the parsed category name").toEqual(["web"]);
  });

  test("THE SECURITY PROPERTY — a non-category tag reaches no participant payload", async () => {
    // Unique, so a hit ANYWHERE in the serialised payload is unambiguous
    // evidence of this challenge's admin tag leaking, and not a coincidence.
    const secret = `needs-review-${stamp()}`;
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const { taskId, compId, adminTags } = await seedTaggedChallenge(sa, saCsrf, ["category:web", secret]);

    // POSITIVE CONTROL. Without this the whole test is satisfied by a tag that
    // was never created — the admin surface DOES return both tags, so the only
    // thing that can make the participant assertions below pass is the filter.
    expect(adminTags.slice().sort(), "the admin endpoint sees BOTH tags").toEqual(["category:web", secret].sort());
    const adminList = await (await sa.get("/api/admin/tasks")).json();
    const adminRow = (adminList.tasks || adminList).find((t) => t.id === taskId);
    expect(adminRow, "the challenge must be visible to the admin").toBeTruthy();
    expect(adminRow.tags.slice().sort()).toEqual(["category:web", secret].sort());
    await sa.dispose();

    const { list, listBody, detailBody } = await readAsParticipant(compId, taskId);

    // 1. Only the category name is exposed…
    expect(list.categories).toEqual(["web"]);
    expect(detailBody.categories).toEqual(["web"]);

    // 2. …the raw tag list is not exposed at all…
    expect(Object.keys(list), "the list entry must carry no `tags` key").not.toContain("tags");
    expect(Object.keys(detailBody), "the detail payload must carry no `tags` key").not.toContain("tags");

    // 3. …and the admin-only tag appears NOWHERE in either payload. This is the
    //    assertion that actually matters: it survives any future field being
    //    added to the response, because it walks the whole serialisation.
    const listJson = JSON.stringify(listBody);
    const detailJson = JSON.stringify(detailBody);
    expect(listJson, "GET /api/tasks leaked an admin-only tag").not.toContain(secret);
    expect(detailJson, "GET /api/tasks/:id leaked an admin-only tag").not.toContain(secret);
    // The raw `category:` tag must not ship either — the client is handed NAMES
    // and does not know the prefix exists (lib/categories.js keeps the parse
    // server-side precisely so there is no client/server pair to drift).
    expect(listJson, "GET /api/tasks shipped a raw tag, not a parsed name").not.toContain("category:");
    expect(detailJson, "GET /api/tasks/:id shipped a raw tag, not a parsed name").not.toContain("category:");
  });

  test("multiple categories come back in a stable order across two fetches", async () => {
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    // Deliberately applied out of alphabetical order: every read site is
    // ORDER BY tag, so the response order must come from the DB ordering and
    // not from the order the admin happened to tag them in.
    const { taskId, compId, adminTags } = await seedTaggedChallenge(
      sa, saCsrf, ["category:web", "category:crypto", "category:api"],
    );
    expect(adminTags.slice().sort()).toEqual(["category:api", "category:crypto", "category:web"]);
    await sa.dispose();

    const first = await readAsParticipant(compId, taskId);
    const second = await readAsParticipant(compId, taskId);

    const expected = ["api", "crypto", "web"];
    expect(first.list.categories).toEqual(expected);
    expect(first.detailBody.categories).toEqual(expected);
    // Stability is the point: same array, twice, from both endpoints.
    expect(second.list.categories).toEqual(first.list.categories);
    expect(second.detailBody.categories).toEqual(first.detailBody.categories);
  });

  test("edge cases: an empty name is not a category, and two spellings collapse to one", async () => {
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    // `category:` with nothing after it, plus two spellings of the same name.
    // The admin tag endpoint trims the whole string and lowercases it, so all
    // three of these are DISTINCT rows in task_tags — asserted below, because
    // if they collapsed at INSERT the participant-side collapse would never be
    // exercised and this test would be vacuous.
    const { taskId, compId, adminTags } = await seedTaggedChallenge(
      sa, saCsrf, ["category:", "category:web", "  category: Web  "],
    );
    expect(
      adminTags.slice().sort(),
      "the three tags must be stored distinctly, or the collapse below proves nothing",
    ).toEqual(["category:", "category: web", "category:web"]);
    await sa.dispose();

    const { list, detailBody } = await readAsParticipant(compId, taskId);
    // Empty name dropped; the two spellings of `web` collapse to exactly one.
    expect(list.categories).toEqual(["web"]);
    expect(detailBody.categories).toEqual(["web"]);
  });

  test("a challenge with NO category tags reports `categories: []`, never absent", async () => {
    const plain = `internal-note-${stamp()}`;
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const { taskId, compId, adminTags } = await seedTaggedChallenge(sa, saCsrf, [plain]);
    expect(adminTags, "positive control: the challenge does carry a tag").toEqual([plain]);
    await sa.dispose();

    const { list, listBody, detailBody } = await readAsParticipant(compId, taskId);
    // The client renders from this array unconditionally, so it must be present
    // and empty rather than undefined — a missing key would need a client guard.
    expect(list).toHaveProperty("categories");
    expect(detailBody).toHaveProperty("categories");
    expect(list.categories).toEqual([]);
    expect(detailBody.categories).toEqual([]);
    // And the non-category tag still does not leak.
    expect(JSON.stringify(listBody)).not.toContain(plain);
    expect(JSON.stringify(detailBody)).not.toContain(plain);
  });
});

test.describe("categoriesFromTags — unit rules (v7.21.0)", () => {
  test("the parse implements every documented rule", async () => {
    // Required INSIDE the test body, not at module scope: per-file isolation
    // recreates the database in a beforeAll, and app modules that reach db.js
    // bind their handle at require time (v7.20.2). lib/categories.js is pure,
    // but the rule is mechanical and worth honouring rather than special-casing.
    const { categoriesFromTags, isCategoryTag, CATEGORY_PREFIX } = require("../lib/categories");

    expect(CATEGORY_PREFIX).toBe("category:");

    // The rule the whole feature rests on: a plain admin tag is NOT a category.
    // This is the positive control for the unit test — an identity function
    // passes every other case in this block.
    expect(categoriesFromTags(["needs-review", "author:jane", "reuse-2024"])).toEqual([]);
    expect(categoriesFromTags(["category:web", "needs-review"])).toEqual(["web"]);

    // The prefix must START the tag — a tag that merely contains it is not one.
    expect(categoriesFromTags(["xcategory:web", "not-category:web", "sub category:web"])).toEqual([]);

    // Empty / whitespace-only names are not categories.
    expect(categoriesFromTags(["category:"])).toEqual([]);
    expect(categoriesFromTags(["category:   "])).toEqual([]);
    expect(categoriesFromTags(["category:", "category:web"])).toEqual(["web"]);

    // Names are trimmed, and matching is case-insensitive (tags are lowercased
    // at insert, but the parse must not depend on that having happened).
    expect(categoriesFromTags(["  category:  web  "])).toEqual(["web"]);
    expect(categoriesFromTags(["CATEGORY:Web"])).toEqual(["web"]);

    // Duplicates collapse — two spellings of one name must not render twice.
    expect(categoriesFromTags(["category:web", "category: web", "CATEGORY:WEB"])).toEqual(["web"]);

    // Order follows the CALLER's tag order, not an internal sort: every read
    // site is ORDER BY tag, so the rendering is stable request to request.
    expect(categoriesFromTags(["category:zebra", "category:alpha", "category:mid"]))
      .toEqual(["zebra", "alpha", "mid"]);

    // Hostile / malformed input must return an empty array, never throw — the
    // list endpoint calls this once per card on a request path.
    for (const bad of [null, undefined, "category:web", 42, {}, { 0: "category:web" }]) {
      expect(categoriesFromTags(/** @type {any} */ (bad))).toEqual([]);
    }
    expect(categoriesFromTags([null, 42, {}, "category:web", undefined])).toEqual(["web"]);

    // The admin-side predicate is derived from the same parse, so it cannot
    // disagree with what a participant is shown.
    expect(isCategoryTag("category:web")).toBe(true);
    expect(isCategoryTag("category:")).toBe(false);
    expect(isCategoryTag("needs-review")).toBe(false);
  });
});
