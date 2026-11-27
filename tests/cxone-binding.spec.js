// @ts-check
/**
 * v8.8.15 — WHICH REALM ACCOUNT, AND WHICH REALM GROUP.
 *
 * Two long-deferred CxOne items, closed together because they are the same
 * shape: the platform was making a binding decision it could not afterwards
 * describe.
 *
 *   * a case typo in the group name produced an account with NO ACCESS, and
 *     v8.3.17 recorded the fold as deferred rather than doing it; and
 *   * `competition_users` stored only the USERNAME a participant was bound
 *     under, which v8.3.17 named as "the only thing that could ever DETECT an
 *     existing mis-binding — the username string never can".
 *
 * HOW THESE ARE LOCKED, AND WHY IT IS NOT UNIFORM. `cxOneProvisionUser` cannot
 * be driven behaviourally THROUGH THE SERVER: `CXONE_HOSTNAME_ALLOWED` refuses a
 * localhost IDP, which is the standing reason this subsystem's existing lock is
 * source-only. (v8.12.6 — a spawned child with a stubbed transport does reach
 * it, tests/cxone-provision-harness.cjs; that harness locks the erasure race and
 * could carry these arms too, but they predate it and are sound as they are.)
 * So the group rule was EXTRACTED into `lib/cxone-identity.js` —
 * pure, requiring nothing — and its whole matrix is asserted at module scope,
 * exactly as v8.3.17 (F1) did for the identity rule and for the same reason.
 * The column half IS behavioural: `db.js` has run by the time this file does,
 * so the schema can simply be read.
 */
const { test, expect } = require("./isolated-test");
const { TEST_DB_PATH } = require("./helpers");
const Database = require("better-sqlite3");

// ═══════════════════════════════════════════════════════════════════════════
// The group rule
// ═══════════════════════════════════════════════════════════════════════════
test.describe("v8.8.15 — a realm group is resolved exactly, then leniently, never ambiguously", () => {
  const { resolveCxOneGroup } = require("../lib/cxone-identity");

  const G = (name, subGroups) => ({ id: `id-${name}`, name, ...(subGroups ? { subGroups } : {}) });

  test("THE REPORTED SHAPE: a case typo still finds the group", () => {
    // The realm search that produced this list is Keycloak's case-INSENSITIVE
    // contains, so `Hackathon-2026` really is what comes back for a search on
    // `hackathon-2026`. Before this the filter beneath it was case-sensitive,
    // and the participant got an account with no group.
    const r = resolveCxOneGroup([G("Hackathon-2026")], "hackathon-2026");
    expect(r.group && r.group.name, "the group is found").toBe("Hackathon-2026");
    expect(r.matchedIgnoringCase, "…and the platform says it had to ignore case").toBe(true);
  });

  test("AN EXACT MATCH WINS over a case-variant sibling — the v8.3.17 blocker", () => {
    // This is the case that made v8.3.17 defer the fold: a realm holding two
    // groups differing only in case. A plain `toLowerCase()` on both sides makes
    // ONE of them permanently unaddressable. Exact-first makes both reachable,
    // which is why the fold could ship at all.
    const realm = [G("Hackathon-2026"), G("hackathon-2026")];
    for (const typed of ["Hackathon-2026", "hackathon-2026"]) {
      const r = resolveCxOneGroup(realm, typed);
      expect(r.group && r.group.name, `"${typed}" binds exactly what was typed`).toBe(typed);
      expect(r.matchedIgnoringCase, "…with no fold involved").toBe(false);
    }
  });

  test("AN AMBIGUOUS FOLD IS REFUSED, and says how many it saw", () => {
    // Two groups differing only in case, and neither typed exactly. There is no
    // right answer, and picking whichever the traversal reached first would put
    // a participant in the wrong cohort — worse than putting them in none, which
    // the caller already reports truthfully.
    const r = resolveCxOneGroup([G("Team-A"), G("team-a"), G("Other")], "TEAM-A");
    expect(r.group, "nothing is bound").toBe(null);
    expect(r.ambiguousCount, "…and the count reaches the operator's log line").toBe(2);
  });

  test("nested subGroups are walked, at every depth", () => {
    const realm = [G("Top", [G("Middle", [G("Deep-Group")])])];
    expect(resolveCxOneGroup(realm, "Deep-Group").group.id, "exact, nested").toBe("id-Deep-Group");
    const ci = resolveCxOneGroup(realm, "deep-group");
    expect(ci.group && ci.group.id, "folded, nested").toBe("id-Deep-Group");
    expect(ci.matchedIgnoringCase).toBe(true);
  });

  test("CONTROL — the fold is NARROW: it is not a substring or a separator match", () => {
    // Without this, "a case typo is tolerated" is equally satisfied by a
    // resolver that binds anything vaguely similar — which on this endpoint
    // means granting a participant access to a group nobody named.
    const realm = [G("Hackathon-2026")];
    for (const wrong of ["hackathon", "hackathon 2026", "hackathon_2026", "hackathon-2027", "ackathon-2026"]) {
      const r = resolveCxOneGroup(realm, wrong);
      expect(r.group, `"${wrong}" resolves to nothing`).toBe(null);
      expect(r.ambiguousCount, `"${wrong}" is a miss, not an ambiguity`).toBe(0);
    }
  });

  test("CONTROL — a missing or empty name resolves to nothing, and does not throw", () => {
    for (const bad of [undefined, null, "", 0, {}]) {
      // @ts-ignore — deliberately wrong types; the caller reads a stored column.
      expect(resolveCxOneGroup([G("X")], bad).group, `${JSON.stringify(bad)} finds nothing`).toBe(null);
    }
    expect(resolveCxOneGroup(null, "X").group, "a missing group list finds nothing").toBe(null);
    expect(resolveCxOneGroup([null, { }, G("X")], "X").group.id, "a malformed entry is skipped").toBe("id-X");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The account id
// ═══════════════════════════════════════════════════════════════════════════
test.describe("v8.8.15 — competition_users records WHICH realm account was bound", () => {
  test("the column exists, and is nullable — NULL means 'bound before this existed'", () => {
    const db = new Database(TEST_DB_PATH, { readonly: true });
    try {
      const cols = db.prepare("PRAGMA table_info(competition_users)").all();
      const col = cols.find(c => c.name === "cxone_user_id");
      expect(col, "cxone_user_id is on competition_users").toBeTruthy();
      expect(col.type, "it is TEXT, like the username beside it").toBe("TEXT");
      // NOT NULL would demand a backfill, and there is nothing honest to
      // backfill WITH: the username cannot be turned into a realm id, and
      // inventing one recreates the exact conflation the column removes.
      expect(col.notnull, "a pre-existing binding stays NULL rather than being invented").toBe(0);
    } finally { db.close(); }
  });

  test("provisioning WRITES it, and compares a prior binding against it", () => {
    // SOURCE-locked, and the reason is the standing one for this whole
    // subsystem: `CXONE_HOSTNAME_ALLOWED` refuses a localhost IDP, so nothing
    // behavioural reaches `cxOneProvisionUser` — mutation-verified, dropping the
    // write-back leaves every other test in this file green. Without this arm
    // the column would be stored by nothing that is checked.
    //
    // Comments stripped first: the code around these statements explains at
    // length why the username could not do this job, quoting the shapes matched
    // here (the v7.21.13 class).
    const fs = require("fs"), path = require("path");
    const raw = fs.readFileSync(path.join(__dirname, "..", "lib", "cxone.js"), "utf8");
    const src = raw.replace(/\/\*[\s\S]*?\*\/|(^|[^:])\/\/[^\n]*/g, (m, pre) => (pre === undefined ? "" : pre));

    // Anti-vacuity: a rename empties every match below and passes in silence.
    expect(src, "the column is named in this module").toContain("cxone_user_id");

    // (a) it is WRITTEN, in the same statement as the username it sits beside —
    //     two statements would be two chances for one to be forgotten.
    expect(src, "the provisioning write-back stores the account id")
      .toMatch(/UPDATE\s+competition_users\s+SET\s+cxone_username=\?,\s*cxone_user_id=\?/);

    // (b) it is READ BACK ACROSS COMPETITIONS, which is the half that makes the
    //     detection work at all: a returning participant has no row for a new
    //     event yet, so a per-competition lookup sees nothing on exactly the
    //     path worth watching.
    expect(src, "a prior binding is looked up by USER, not by (user, competition)")
      .toMatch(/SELECT cxone_user_id FROM competition_users WHERE user_id=\? AND cxone_user_id IS NOT NULL AND cxone_user_id<>\?/);

    // (c) a change is REPORTED, never refused. Re-pointing a participant at a
    //     different realm account is a legitimate administrative act — an
    //     account deleted and recreated, or v8.3.17's own unbind remedy — and
    //     nothing here can tell that from the accident. Throwing would turn a
    //     diagnostic into an outage for the legitimate case.
    expect(src, "a changed binding is reported").toMatch(/console\.warn\([^)]*cxIdChangedFrom|cxIdChangedFrom[\s\S]{0,400}console\.warn/);
    expect(src, "…and rides the audit event only when it happened")
      .toContain("cxone_user_id_changed_from: cxIdChangedFrom");
    expect(src, "…so an ordinary provisioning row keeps its shape")
      .toMatch(/\.\.\.\(cxIdChangedFrom \? \{/);
    expect(src, "the detection never throws").not.toMatch(/throw new Error\([^)]*cxIdChangedFrom/);
  });

  test("the schema manifest DECIDES about it, so /readyz would report it missing", () => {
    // v8.3.39's rule: every ALTER-added column is decided about by
    // lib/schema-required.js, in both directions. Registering it is what makes a
    // half-applied migration visible rather than silent.
    const { REQUIRED_COLUMNS } = require("../lib/schema-required");
    expect(REQUIRED_COLUMNS.competition_users, "the table is in the manifest").toBeTruthy();
    expect(REQUIRED_COLUMNS.competition_users, "…and names the new column")
      .toContain("cxone_user_id");
  });
});
