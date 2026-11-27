// @ts-check
//
// v8.17.0 — TEMPLATE PROTECTION, SERVER-ENFORCED.
//
//   * A built-in template can never be deleted (409 template_protected) and has
//     Reset to default; a template a global admin marks Protected cannot be
//     deleted by anyone until it is unprotected.
//   * Deleting any other template is a SOFT delete: it leaves the list, appears
//     under Recently deleted, and one call restores it. The retention sweep
//     purges it after TEMPLATE_RESTORE_DAYS (driven with a shrunk TTL).
//   * Restore built-in templates recreates a built-in that no longer exists.
//   * An event admin is refused every one of these doors.
// Each refusal is paired with a positive control on the same kind of row, so a
// build that refuses everything (or nothing) fails.
const { test, expect } = require("./isolated-test");
const { TEST_DB_PATH } = require("./helpers");
const { H, uniq, buildWorld } = require("./event-admin-helpers");
const Database = require("better-sqlite3");

const ro = () => new Database(TEST_DB_PATH, { readonly: true });

let W;
test.beforeAll(async () => { W = await buildWorld(); });
test.afterAll(async () => {
  for (const a of [W && W.sa, W && W.eaApi, W && W.zeroApi]) {
    if (!a) continue;
    try { await a.dispose(); } catch (e) { console.warn("dispose failed:", e && e.message); }
  }
});

async function makeTpl(name) {
  const { sa, saCsrf } = W;
  const r = await sa.post("/api/admin/event-templates", { headers: H(saCsrf), data: { name, event_kind: "tournament", settings: { duration_minutes: 45 } } });
  expect(r.status(), await r.text()).toBe(200);
  return (await r.json()).template;
}
const listed = async (id) => ((await (await W.sa.get("/api/admin/event-templates")).json()).templates || []).find(t => t.id === id);

test.describe("v8.17.0 — event template protection", () => {
  test("a built-in cannot be deleted, says so on the wire, and resets to its default", async () => {
    const { sa, saCsrf } = W;
    const list = (await (await sa.get("/api/admin/event-templates")).json()).templates;
    const bi = list.find(t => t.is_builtin && t.builtin_key === "tournament-2h");
    expect(bi, "PRECONDITION: the built-in Tournament template is listed with its key").toBeTruthy();
    expect(bi.can_delete).toBe(false);
    expect(bi.delete_refused).toMatch(/built-in/i);
    const del = await sa.delete(`/api/admin/event-templates/${bi.id}`, { headers: H(saCsrf) });
    expect(del.status()).toBe(409);
    expect((await del.json()).code).toBe("template_protected");
    expect(await listed(bi.id), "still listed after the refused delete").toBeTruthy();
    // Edit it, then reset: the shipped definition comes back.
    const ed = await sa.put(`/api/admin/event-templates/${bi.id}`, { headers: H(saCsrf), data: { name: `Edited built-in ${uniq("b")}`, settings: { duration_minutes: 33 } } });
    expect(ed.status(), await ed.text()).toBe(200);
    const rs = await sa.post(`/api/admin/event-templates/${bi.id}/reset`, { headers: H(saCsrf) });
    expect(rs.status(), await rs.text()).toBe(200);
    const after = (await rs.json()).template;
    expect(after.name).toBe("Competition (several sessions)");
    expect(after.settings.duration_minutes).toBe(120);
    // CONTROL: reset is refused on an administrator's template.
    const own = await makeTpl(`Own ${uniq("o")}`);
    const r2 = await sa.post(`/api/admin/event-templates/${own.id}/reset`, { headers: H(saCsrf) });
    expect(r2.status()).toBe(409);
    expect((await r2.json()).code).toBe("template_not_builtin");
    // A built-in is always protected: the switch is refused on one.
    const p = await sa.post(`/api/admin/event-templates/${bi.id}/protect`, { headers: H(saCsrf), data: { protected: false } });
    expect(p.status()).toBe(409);
  });

  test("a protected template cannot be deleted until it is unprotected", async () => {
    const { sa, saCsrf } = W;
    const t = await makeTpl(`Prot ${uniq("p")}`);
    expect(t.can_delete, "PRECONDITION: an ordinary template may be deleted").toBe(true);
    const p = await sa.post(`/api/admin/event-templates/${t.id}/protect`, { headers: H(saCsrf), data: { protected: true } });
    expect(p.status(), await p.text()).toBe(200);
    expect((await p.json()).template.protected).toBe(true);
    const del = await sa.delete(`/api/admin/event-templates/${t.id}`, { headers: H(saCsrf) });
    expect(del.status()).toBe(409);
    expect((await del.json()).code).toBe("template_protected");
    const db = ro();
    try { expect(db.prepare("SELECT deleted_at d FROM event_templates WHERE id=?").get(t.id).d, "the refused delete wrote nothing").toBeNull(); }
    finally { db.close(); }
    expect((await sa.post(`/api/admin/event-templates/${t.id}/protect`, { headers: H(saCsrf), data: { protected: "yes" } })).status(), "a non-boolean is refused").toBe(400);
    const up = await sa.post(`/api/admin/event-templates/${t.id}/protect`, { headers: H(saCsrf), data: { protected: false } });
    expect(up.status()).toBe(200);
    const del2 = await sa.delete(`/api/admin/event-templates/${t.id}`, { headers: H(saCsrf) });
    expect(del2.status(), "unprotected, it deletes").toBe(200);
  });

  test("delete is soft: Recently deleted lists it, Restore brings it back, and the sweep purges it later", async () => {
    const { sa, saCsrf } = W;
    const name = `Soft ${uniq("s")}`;
    const t = await makeTpl(name);
    const del = await sa.delete(`/api/admin/event-templates/${t.id}`, { headers: H(saCsrf) });
    expect(del.status(), await del.text()).toBe(200);
    expect(await listed(t.id), "gone from the list").toBeFalsy();
    expect((await sa.get(`/api/admin/event-templates/${t.id}`)).status()).toBe(404);
    expect((await sa.post(`/api/admin/event-templates/${t.id}/spawn`, { headers: H(saCsrf), data: { name: `x ${uniq("x")}` } })).status(), "a deleted template cannot be spawned").toBe(404);
    const gone = await (await sa.get("/api/admin/event-templates/deleted")).json();
    const row = gone.templates.find(x => x.id === t.id);
    expect(row, "listed under Recently deleted").toBeTruthy();
    expect(row.purge_at).toBeTruthy();
    // Its name stays taken while it can be restored, and the refusal says why.
    const dup = await sa.post("/api/admin/event-templates", { headers: H(saCsrf), data: { name, event_kind: "tournament", settings: { duration_minutes: 5 } } });
    expect(dup.status()).toBe(409);
    expect((await dup.json()).error).toMatch(/recently deleted/i);
    const rs = await sa.post(`/api/admin/event-templates/${t.id}/restore`, { headers: H(saCsrf) });
    expect(rs.status(), await rs.text()).toBe(200);
    expect(await listed(t.id), "restored to the list").toBeTruthy();
    expect((await sa.post(`/api/admin/event-templates/${t.id}/restore`, { headers: H(saCsrf) })).status(), "restoring a live one is a 404").toBe(404);

    // Purge: delete again, then a sweep with a 0 ms window removes it; a sweep
    // with the default window first (CONTROL) leaves it.
    expect((await sa.delete(`/api/admin/event-templates/${t.id}`, { headers: H(saCsrf) })).status()).toBe(200);
    const keep = await (await sa.post("/api/test/purge-events", { headers: H(saCsrf), data: {} })).json();
    expect(keep.templates_purged, "CONTROL: a fresh deletion survives the daily sweep").toBe(0);
    const db1 = ro();
    try { expect(db1.prepare("SELECT 1 x FROM event_templates WHERE id=?").get(t.id)).toBeTruthy(); } finally { db1.close(); }
    const purge = await (await sa.post("/api/test/purge-events", { headers: H(saCsrf), data: { templateTtlMs: 0 } })).json();
    expect(purge.templates_purged).toBeGreaterThanOrEqual(1);
    const db2 = ro();
    try { expect(db2.prepare("SELECT 1 x FROM event_templates WHERE id=?").get(t.id), "purged").toBeFalsy(); } finally { db2.close(); }
  });

  test("Restore built-in templates recreates a missing built-in, once", async () => {
    const { sa, saCsrf } = W;
    // A built-in can no longer be deleted through the API; a pre-protection
    // deletion is simulated by removing the row directly.
    const db = new Database(TEST_DB_PATH);
    let removed;
    try {
      removed = db.prepare("SELECT id, name FROM event_templates WHERE builtin_key='booth-quick-spin'").get();
      expect(removed, "PRECONDITION: the booth built-in exists").toBeTruthy();
      db.prepare("DELETE FROM event_templates WHERE id=?").run(removed.id);
    } finally { db.close(); }
    const before = await (await sa.get("/api/admin/event-templates/deleted")).json();
    expect(before.missing_builtins).toContain("Booth day (8 hours)");
    const r = await sa.post("/api/admin/event-templates/restore-builtins", { headers: H(saCsrf) });
    expect(r.status(), await r.text()).toBe(200);
    const body = await r.json();
    expect(body.restored.map(x => x.builtin_key)).toEqual(["booth-quick-spin"]);
    const again = await (await sa.post("/api/admin/event-templates/restore-builtins", { headers: H(saCsrf) })).json();
    expect(again.restored, "nothing is missing the second time").toEqual([]);
    const list = (await (await sa.get("/api/admin/event-templates")).json()).templates;
    expect(list.filter(t => t.builtin_key === "booth-quick-spin")).toHaveLength(1);
  });

  test("an event admin is refused every protection door", async () => {
    const { eaApi, eaCsrf } = W;
    const t = await makeTpl(`EA prot ${uniq("e")}`);
    for (const [method, url, data] of [
      ["get", "/api/admin/event-templates/deleted", undefined],
      ["post", "/api/admin/event-templates/restore-builtins", undefined],
      ["post", `/api/admin/event-templates/${t.id}/protect`, { protected: true }],
      ["post", `/api/admin/event-templates/${t.id}/restore`, undefined],
      ["post", `/api/admin/event-templates/${t.id}/reset`, undefined],
      ["delete", `/api/admin/event-templates/${t.id}`, undefined],
    ]) {
      const r = await eaApi[method](url, { headers: H(eaCsrf), ...(data ? { data } : {}) });
      expect(r.status(), `${method} ${url}`).toBe(403);
      expect((await r.json()).code).toBe("event_admin_forbidden");
    }
    expect(await listed(t.id), "CONTROL: the template is untouched").toBeTruthy();
    expect((await listed(t.id)).protected).toBe(false);
  });
});
