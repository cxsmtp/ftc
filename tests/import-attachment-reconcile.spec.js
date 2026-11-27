// @ts-check
// ═══════════════════════════════════════════════════════════════════════════
// v8.3.34 (external audit) — A CHALLENGE IMPORT LEAVES NO ORPHAN ZIP
//
// `POST /api/admin/import/tasks` decides what to promote in a PRE-FLIGHT loop
// and moves each ZIP into DATA_DIR/attachments/ BEFORE the transaction — which
// is deliberate and correct (a failure AFTER the txn would leave rows pointing
// at missing files). The defect was that the pre-flight loop modelled THREE of
// the transaction's SEVEN skip branches. The four it missed — an invalid
// difficulty/answer_type enum, an unanswerable choice row, a challenge frozen
// by an ended session, and a challenge unfit for its Booth Event — were each
// added by a later release and none reached the pre-flight loop, so a row
// skipped by any of them had its ZIP promoted and got no `task_attachments`
// row.
//
// The fix is a post-commit reconciliation against what the transaction ACTUALLY
// inserted, so a FIFTH skip branch is handled without anyone remembering. This
// lock therefore asserts the INVARIANT (no orphans after an import), not the
// mechanism — the mechanism is what kept drifting.
//
// SEVERITY, stated because the filing overstated it: the orphan is inert (the
// download route resolves through `task_attachments`, so a row-less file is
// unreachable) and `_sweepPermanentAttachments()` reclaims it daily, so this
// was bounded transient disk use, not the unbounded growth filed.
// ═══════════════════════════════════════════════════════════════════════════
const { test, expect } = require("./isolated-test");
const { apiLogin, TEST_DATA_DIR } = require("./helpers");
const fs = require("fs");
const path = require("path");

// The smallest valid zip: a bare 22-byte end-of-central-directory record.
const EMPTY_ZIP_B64 = "UEsFBgAAAAAAAAAAAAAAAAAAAAAAAA==";
const ATTACH_DIR = path.join(TEST_DATA_DIR, "attachments");
const countFiles = () => (fs.existsSync(ATTACH_DIR) ? fs.readdirSync(ATTACH_DIR).length : 0);

const taskWithZip = (title, difficulty) => ({
  title, difficulty, correct_answer: "a", answer_type: "text",
  attachments: [{ display_name: "recon", original_name: "recon.zip", size_bytes: 22, content_b64: EMPTY_ZIP_B64 }],
});

test.describe("v8.3.34 — the challenge import reconciles promoted attachments", () => {
  test("POSITIVE CONTROL — a row that IMPORTS really does promote its file", async () => {
    // Without this the negative test below is satisfied by a build where the
    // fixture's ZIP is rejected before promotion and nothing was ever at risk —
    // the exact vacuity the sibling v6.20.6 lock carries (it `return`s early
    // when the validator rejects the empty zip, asserting nothing).
    const { api: sa, csrf } = await apiLogin("superadmin");
    const h = { "x-csrf-token": csrf, "content-type": "application/json" };
    let taskId = null;
    try {
      const title = `ReconOk-${Date.now().toString(36)}`;
      const before = countFiles();
      const r = await sa.post("/api/admin/import/tasks", {
        headers: h, data: { data: { type: "hackarena-tasks", tasks: [taskWithZip(title, "easy")] }, resolutions: {} },
      });
      expect(r.status(), `import: ${await r.text().catch(() => "")}`).toBe(200);
      const body = await r.json();
      expect(body.imported, "the row imported").toBe(1);
      expect(body.attachments_imported, "and its attachment was stored").toBe(1);
      expect(countFiles(), "exactly one file was promoted and KEPT").toBe(before + 1);

      const list = await (await sa.get("/api/admin/tasks?limit=5000")).json();
      taskId = (list.tasks || list || []).find?.(t => t.title === title)?.id;
    } finally {
      if (taskId) await sa.delete(`/api/admin/tasks/${taskId}`, { headers: { "x-csrf-token": csrf } }).catch(() => {});
      await sa.dispose();
    }
  });

  test("a row SKIPPED inside the transaction leaves no promoted file behind", async () => {
    // `difficulty:"trivial"` is the cheapest of the four unmodelled branches: it
    // is a truthy string, so it clears the pre-flight guard and its ZIP IS
    // promoted, and it dies at the enum check inside the transaction. No lock,
    // freeze or Booth Event needed to reach the class.
    const { api: sa, csrf } = await apiLogin("superadmin");
    const h = { "x-csrf-token": csrf, "content-type": "application/json" };
    try {
      const title = `ReconSkip-${Date.now().toString(36)}`;
      const before = countFiles();
      const r = await sa.post("/api/admin/import/tasks", {
        headers: h, data: { data: { type: "hackarena-tasks", tasks: [taskWithZip(title, "trivial")] }, resolutions: {} },
      });
      expect(r.status(), `import: ${await r.text().catch(() => "")}`).toBe(200);
      const body = await r.json();
      // PRECONDITIONS — this must be the SKIP path, not a 400 and not an import.
      expect(body.skipped, "the bad-enum row is skipped, not imported").toBe(1);
      expect(body.imported, "nothing was imported").toBe(0);
      expect(body.attachments_imported || 0, "and no attachment row was written").toBe(0);

      // THE ASSERTION. Pre-fix this read `before + 1` — a promoted ZIP with no
      // row referencing it, reachable by nothing and reclaimed only by the
      // next daily sweep.
      expect(countFiles(), "the promoted file was reclaimed, not orphaned").toBe(before);
    } finally { await sa.dispose(); }
  });
});
