// @ts-check
//
// "ALLOW INSTANT JOIN" IS RETIRED (operator ruling, 14 Nov 2026).
//
// Every sign-up proves its address with an emailed code before the account
// exists, and a join-link sign-up is approved whatever the setting, so the
// switch changed nothing. It is refused BY NAME wherever it could be sent (the
// event create and edit: tests/join-code-reach.spec.js; a template's settings,
// here), named on no response, and offered by no screen. A template stored with
// it before the ruling is still read and spawned: the stored key is dropped on
// read, and the template's next save removes it from storage.
const { test, expect } = require("./isolated-test");
const Database = require("better-sqlite3");
const { apiLogin, TEST_DB_PATH, BASE } = require("./helpers");

test.use({ baseURL: BASE });

const H = (c) => ({ "x-csrf-token": c, "content-type": "application/json" });
const uniq = (p) => `${p} ${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const dbGet = (sql, ...a) => { const db = new Database(TEST_DB_PATH, { readonly: true }); try { return db.prepare(sql).get(...a); } finally { db.close(); } };
const dbRun = (sql, ...a) => { const db = new Database(TEST_DB_PATH); try { return db.prepare(sql).run(...a); } finally { db.close(); } };

test.describe("\"Allow instant join\" is retired (operator ruling, 14 Nov 2026)", () => {
  test("a template's settings naming it are refused by name, at create and at edit; the same template without it saves (CONTROL)", async () => {
    const { api, csrf } = await apiLogin("superadmin");
    try {
      const name = uniq("Instant tpl");
      for (const v of [true, false]) {
        const r = await api.post("/api/admin/event-templates", { headers: H(csrf), data: {
          name, event_kind: "booth", settings: { duration_minutes: 60, self_enroll_enabled: true, self_enroll_allow_instant: v } } });
        expect(r.status(), `create with the switch ${v}: ${await r.text()}`).toBe(400);
        const b = await r.json();
        expect(b.code).toBe("self_enroll_instant_removed");
        expect(b.setting, "the refusal names the setting").toBe("self_enroll_allow_instant");
      }
      expect(dbGet("SELECT COUNT(*) AS n FROM event_templates WHERE name=?", name).n, "the refused creates stored nothing").toBe(0);

      const ok = await api.post("/api/admin/event-templates", { headers: H(csrf), data: {
        name, event_kind: "booth", settings: { duration_minutes: 60, self_enroll_enabled: true } } });
      expect(ok.status(), `CONTROL — the create without it: ${await ok.text()}`).toBe(200);
      const tpl = (await ok.json()).template;
      const put = await api.put(`/api/admin/event-templates/${tpl.id}`, { headers: H(csrf), data: {
        settings: { duration_minutes: 60, self_enroll_allow_instant: true }, expectedUpdatedAt: tpl.updated_at } });
      expect(put.status(), `edit with the switch: ${await put.text()}`).toBe(400);
      expect((await put.json()).code).toBe("self_enroll_instant_removed");
      expect(JSON.parse(dbGet("SELECT settings FROM event_templates WHERE id=?", tpl.id).settings),
        "the refused edit changed nothing").not.toHaveProperty("self_enroll_allow_instant");
    } finally { await api.dispose(); }
  });

  test("a template STORED with it before the ruling is read without it, still spawns, and its next save drops it", async () => {
    const { api, csrf } = await apiLogin("superadmin");
    try {
      const name = uniq("Stored instant");
      const c = await api.post("/api/admin/event-templates", { headers: H(csrf), data: {
        name, event_kind: "booth", settings: { duration_minutes: 45, self_enroll_enabled: true } } });
      expect(c.status(), await c.text()).toBe(200);
      const id = (await c.json()).template.id;
      // The state a template saved before the ruling is in: the key in storage.
      dbRun("UPDATE event_templates SET settings=? WHERE id=?",
        JSON.stringify({ duration_minutes: 45, self_enroll_enabled: true, self_enroll_allow_instant: true }), id);
      expect(JSON.parse(dbGet("SELECT settings FROM event_templates WHERE id=?", id).settings),
        "PRECONDITION: the retired key is stored").toHaveProperty("self_enroll_allow_instant", true);

      const read = await (await api.get(`/api/admin/event-templates/${id}`)).json();
      expect(read.template.settings, "the read leaves the retired key out").not.toHaveProperty("self_enroll_allow_instant");
      expect(read.template.settings.duration_minutes, "CONTROL: the rest is read").toBe(45);

      const sp = await api.post(`/api/admin/event-templates/${id}/spawn`, { headers: H(csrf), data: { name: uniq("From stored") } });
      expect(sp.status(), `the spawn still works: ${await sp.text()}`).toBe(200);
      const ev = (await sp.json()).competition;
      expect(ev, "the spawned event names no retired switch").not.toHaveProperty("self_enroll_allow_instant");
      expect(dbGet("SELECT self_enroll_enabled FROM competitions WHERE id=?", ev.id).self_enroll_enabled, "CONTROL: its settings applied").toBe(1);

      // The next save (a description edit, settings untouched) rewrites storage without it.
      const put = await api.put(`/api/admin/event-templates/${id}`, { headers: H(csrf), data: { description: "edited", expectedUpdatedAt: read.template.updated_at } });
      expect(put.status(), await put.text()).toBe(200);
      const stored = JSON.parse(dbGet("SELECT settings FROM event_templates WHERE id=?", id).settings);
      expect(stored, "the save dropped the retired key").not.toHaveProperty("self_enroll_allow_instant");
      expect(stored.duration_minutes, "CONTROL: and kept the rest").toBe(45);
    } finally { await api.dispose(); }
  });

  test("no response names it: the join-link reveal, its public preview and the built-in templates", async () => {
    const { api, csrf } = await apiLogin("superadmin");
    try {
      const r = await api.post("/api/admin/competitions", { headers: H(csrf), data: {
        name: uniq("Retired switch wire"), event_kind: "booth", timezone: "UTC",
        start_time: new Date(Date.now() + 3600e3).toISOString(), duration_minutes: 60 } });
      expect(r.status(), await r.text()).toBe(200);
      const ev = (await r.json()).competition;
      const rv = await (await api.get(`/api/admin/competitions/${ev.id}/self-enroll`)).json();
      expect(typeof rv.token, "CONTROL: the reveal answered").toBe("string");
      expect(rv).not.toHaveProperty("allow_instant");
      const pv = await (await api.get(`/api/competitions/self-enroll/${rv.token}`)).json();
      expect(pv.id, "CONTROL: the preview answered for this event").toBe(ev.id);
      expect(JSON.stringify(pv), "the preview names no instant join").not.toMatch(/instant/i);
      const tpls = (await (await api.get("/api/admin/event-templates")).json()).templates;
      const booth = tpls.find((t) => t.is_builtin && t.event_kind === "booth");
      expect(booth, "PRECONDITION: the built-in Booth Event template").toBeTruthy();
      expect(Object.keys(booth.settings).sort(), "the built-in carries no retired switch").toEqual(["duration_minutes", "self_enroll_enabled"]);
      expect(booth.description, "nor promises instant entry").not.toMatch(/instant/i);
    } finally { await api.dispose(); }
  });

  test("no screen offers it: no SPA module names the switch", () => {
    // A source scanner over the SPA (comments stripped), with a planted control.
    const fs = require("fs");
    const path = require("path");
    const { stripJsComments } = require("./doc-registry");
    const RETIRED = /self_enroll_allow_instant|self-enroll-instant|allow_instant|Allow instant join|instant play/;
    expect(RETIRED.test("<input id=\"self-enroll-instant\"/> Allow instant join"), "CONTROL: the shape is recognised").toBe(true);
    const root = path.join(__dirname, "..", "public", "js");
    const files = [];
    const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith(".js")) files.push(p); } };
    walk(root);
    expect(files.length, "the SPA's modules were read").toBeGreaterThan(40);
    const hits = [];
    for (const f of files) {
      stripJsComments(fs.readFileSync(f, "utf8")).split("\n").forEach((line, i) => { if (RETIRED.test(line)) hits.push(`${path.relative(root, f)}:${i + 1}`); });
    }
    expect(hits, "a screen still offers or reads the retired switch").toEqual([]);
    const shell = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
    expect(RETIRED.test(shell), "nor does the shell").toBe(false);
  });
});
