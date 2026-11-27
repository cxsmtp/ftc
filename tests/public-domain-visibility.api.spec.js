// @ts-check
//
// v8.8.2 — THE PUBLIC-DOMAIN TAG IS THE THIRD ARM, AND IT IS AN EXACT STRING.
//
// An event admin sees a challenge when (a) they created it, (b) one of their
// events holds it, or (c) it carries the `public-domain` tag. Arm (c) is a shared
// pool: tag a challenge and every event admin on the platform may use it.
//
// Reported: "I should be able to see challenges created by someone else or
// already associated with the event or challenges marked as public domain. Yet I
// don't see the latter."
//
// THE SERVER RULE WAS NEVER BROKEN — measured before anything changed, the list
// query's three arms are all present and a correctly tagged challenge IS
// returned. What was broken is that the value had to be TYPED, into a free-text
// box that accepts anything: "public domain" is stored verbatim, renders on the
// row as a tag, and grants nothing. Accept-and-ignore — a control that appears to
// work, which this codebase treats as worse than no control. The fix is the Add
// Tag dialog's one-click chip, locked in public-domain-tag-ui.spec.js.
//
// THIS FILE PINS THE RULE THE CHIP EXISTS TO SATISFY, and the near-miss arms are
// the reason it is worth having: they assert that the platform does NOT quietly
// fold a space or a missing hyphen into the reserved value. That is deliberate.
// Folding would GRANT cross-organiser visibility to somebody who tagged a
// challenge "public domain" as an ordinary descriptive label — a silent widening
// of who can see what, which is exactly the wrong direction to be generous in.

const { test, expect } = require("./isolated-test");
const { H, buildWorld, makeTask } = require("./event-admin-helpers");

const TAG = "public-domain";

/** Tag as the superadmin, asserting the value that was actually STORED. */
async function tagAs(api, csrf, taskId, tag) {
  const r = await api.post(`/api/admin/tasks/${taskId}/tags`, { headers: H(csrf), data: { tag } });
  expect(r.ok(), `tag "${tag}": ${r.status()} ${await r.text()}`).toBeTruthy();
  return (await r.json()).tags;
}

/** The ids an actor can see in the unscoped challenge list. */
async function visibleIds(api) {
  const r = await api.get("/api/admin/tasks");
  expect(r.ok(), `tasks list: ${r.status()}`).toBeTruthy();
  const body = await r.json();
  expect(Array.isArray(body), "the admin tasks list answers a bare array").toBeTruthy();
  return new Set(body.map(t => t.id));
}

test.describe("v8.8.2 — the public-domain shared pool", () => {
  /** @type {any} */ let w;

  test.beforeAll(async () => {
    test.setTimeout(180_000);
    w = await buildWorld();
  });

  test("a PUBLISHED challenge somebody else created is visible once tagged", async () => {
    const t = await makeTask(w.sa, w.saCsrf, "pdpub");
    // Before: invisible. Without this the test cannot tell the tag from a build
    // that shows an event admin every challenge on the platform.
    expect((await visibleIds(w.eaApi)).has(t.id), "not visible before tagging").toBe(false);
    expect(await tagAs(w.sa, w.saCsrf, t.id, TAG), "the tag was stored verbatim").toContain(TAG);
    expect((await visibleIds(w.eaApi)).has(t.id), "visible once tagged").toBe(true);
  });

  test("a DRAFT is visible too — the tag is the only route to one they did not create", async () => {
    const t = await makeTask(w.sa, w.saCsrf, "pddraft", { status: "draft" });
    expect((await visibleIds(w.eaApi)).has(t.id), "not visible before tagging").toBe(false);
    await tagAs(w.sa, w.saCsrf, t.id, TAG);
    expect((await visibleIds(w.eaApi)).has(t.id), "visible once tagged").toBe(true);
  });

  test("CASING round-trips — tag writes lowercase, so Public-Domain grants too", async () => {
    for (const spelling of ["Public-Domain", "PUBLIC-DOMAIN"]) {
      const t = await makeTask(w.sa, w.saCsrf, `pdcase${spelling.length}`);
      const stored = await tagAs(w.sa, w.saCsrf, t.id, spelling);
      expect(stored, `"${spelling}" is stored lowercased`).toContain(TAG);
      expect((await visibleIds(w.eaApi)).has(t.id), `"${spelling}" grants visibility`).toBe(true);
    }
  });

  // v8.8.3 — RE-POINTED, not weakened. Its subject was always "a near miss must
  // not silently become the reserved tag"; what changed is that the write is now
  // REFUSED rather than stored-and-inert. Both halves are asserted, because the
  // anti-fold property is the one this file exists for: a build that "fixed" the
  // report by normalising separators would grant platform-wide visibility to a
  // challenge somebody labelled descriptively, and would pass a test that only
  // checked the challenge had become visible.
  //
  // The list is the MEASURED confusable family, not the three visibly-distinct
  // spellings v8.8.2 tested. A SOFT HYPHEN and a ZERO-WIDTH SPACE render
  // PIXEL-IDENTICALLY to the reserved value in the tag chip, so before this
  // release an operator could read `public-domain` on the row and have it grant
  // nothing, with nothing on any screen able to tell them why.
  test("a near miss is REFUSED, and is never folded into the reserved tag", async () => {
    const NEAR = [
      ["space",            "public domain"],
      ["no separator",     "publicdomain"],
      ["underscore",       "public_domain"],
      ["en dash",          "public\u2013domain"],
      ["em dash",          "public\u2014domain"],
      ["non-breaking hyphen", "public\u2011domain"],
      ["minus sign",       "public\u2212domain"],
      ["fullwidth hyphen", "public\uff0ddomain"],
      ["NBSP",             "public\u00a0domain"],
      ["SOFT HYPHEN",      "public\u00addomain"],
      ["ZERO-WIDTH SPACE", "public\u200bdomain"],
      ["mixed case + space", "Public Domain"],
    ];
    for (let i = 0; i < NEAR.length; i++) {
      const [name, spelling] = NEAR[i];
      const t = await makeTask(w.sa, w.saCsrf, `pdnear${i}`);
      const r = await w.sa.post(`/api/admin/tasks/${t.id}/tags`, { headers: H(w.saCsrf), data: { tag: spelling } });
      expect(r.status(), `${name}: refused with 400`).toBe(400);
      const body = await r.json();
      expect(body.code, `${name}: names the machine-readable reason`).toBe("public_domain_near_miss");
      expect(body.error, `${name}: the refusal names the reserved spelling`).toContain(TAG);

      // Nothing was written — neither the near miss NOR the reserved tag. The
      // second half is the anti-fold assertion: a refusal, not a silent upgrade.
      const after = await w.sa.get(`/api/admin/tasks`);
      const row = (await after.json()).find(x => x.id === t.id);
      expect(row.tags || [], `${name}: the near miss was not stored`).toEqual([]);
      expect((await visibleIds(w.eaApi)).has(t.id), `${name}: grants NOTHING`).toBe(false);
    }
  });

  test("CONTROL — the refusal is NARROW: an ordinary tag that merely resembles it is accepted", async () => {
    // Without this, "near misses are refused" is equally satisfied by a build
    // that refuses every tag containing the word "public", which would be a
    // strictly worse product than the accept-and-ignore it replaced.
    for (const ok of ["public-domain-2024", "publicdomains", "category:public-domain", "public"]) {
      const t = await makeTask(w.sa, w.saCsrf, `pdok${ok.length}`);
      const stored = await tagAs(w.sa, w.saCsrf, t.id, ok);
      expect(stored, `"${ok}" is an ordinary tag and is stored`).toContain(ok.toLowerCase());
      expect((await visibleIds(w.eaApi)).has(t.id), `"${ok}" grants nothing, being an ordinary tag`).toBe(false);
    }
  });

  test("CONTROL — an untagged challenge by another author stays invisible", async () => {
    // Without this, every assertion above is satisfied by a build that shows an
    // event admin the whole challenge bank.
    const t = await makeTask(w.sa, w.saCsrf, "pdcontrol");
    expect((await visibleIds(w.eaApi)).has(t.id), "no arm applies, so it is not visible").toBe(false);
  });

  test("a ZERO-GRANT event admin sees it too — the pool does not depend on holding an event", async () => {
    // `scopedCompetitionIds` answers [] for them, so the event arm is dropped
    // entirely; the public-domain arm must survive that. This is the actor a
    // naive `ids.length ? clause : ""` would show EVERYTHING, so the control
    // beside it matters as much as the positive.
    const t = await makeTask(w.sa, w.saCsrf, "pdzero");
    await tagAs(w.sa, w.saCsrf, t.id, TAG);
    const seen = await visibleIds(w.zeroApi);
    expect(seen.has(t.id), "the shared pool reaches an organiser with no events").toBe(true);

    const priv = await makeTask(w.sa, w.saCsrf, "pdzeroctl");
    expect(seen.has(priv.id) || (await visibleIds(w.zeroApi)).has(priv.id),
      "…and nothing else does").toBe(false);
  });
});
