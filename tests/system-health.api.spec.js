// @ts-check
//
// GET /api/admin/system-health (Settings → Backups & health). Locked here:
//   • a superadmin gets every fact, the superadmin-only details included
//     (database size, Node.js version, process start time);
//   • a regular admin (settings.view) gets the same facts WITHOUT those three
//     keys (absent, not null), with the superadmin as the CONTROL that they exist;
//   • an event admin is refused (settings.view is not theirs; the gate's
//     event_admin_forbidden);
//   • no value is a filesystem path, and none names the data or uploads folder.
const { test, expect } = require("./isolated-test");
const { BASE, apiLogin, TEST_DATA_DIR } = require("./helpers");
const { H, makeParticipant, makeCompetition, grantEventAdmin } = require("./event-admin-helpers");

test.use({ baseURL: BASE });

const SHARED = ["version", "database_integrity_ok", "database_schema_ok", "maintenance", "smtp_healthy", "smtp_checked_at",
  "build", "backups", "uptime_seconds", "data_free_gib", "uploads_free_gib", "event_retention_days"];
const SUPERADMIN_ONLY = ["database_size_mib", "node_version", "started_at"];

/** Every string value anywhere in the body. */
function strings(v, out = []) {
  if (typeof v === "string") out.push(v);
  else if (v && typeof v === "object") for (const x of Object.values(v)) strings(x, out);
  return out;
}
function expectNoPath(body, who) {
  for (const s of strings(body)) {
    expect(s, `${who}: "${s}" is not a path`).not.toMatch(/[\\/]/);
  }
  const text = JSON.stringify(body);
  if (TEST_DATA_DIR) expect(text, `${who}: the data folder is not named`).not.toContain(TEST_DATA_DIR);
  expect(text, `${who}: no database file name`).not.toContain("hackathon.db");
}

let fx;
test.beforeAll(async () => {
  test.setTimeout(120_000);
  const { api: sa, csrf } = await apiLogin("superadmin");
  const admin = await makeParticipant(sa, csrf, "healthadmin");
  const p = await sa.post(`/api/admin/participants/${admin.id}/role`, { headers: H(csrf), data: { role: "admin" } });
  expect(p.ok(), `promote to admin: ${p.status()} ${await p.text()}`).toBeTruthy();
  const ea = await makeParticipant(sa, csrf, "healthea");
  const comp = await makeCompetition(sa, csrf, "health-event");
  await grantEventAdmin(sa, csrf, comp.id, ea.id);
  fx = { sa, admin, ea };
});
test.afterAll(async () => { if (fx) await fx.sa.dispose(); });

test("a superadmin sees every fact, the details included, and no path", async () => {
  const r = await fx.sa.get("/api/admin/system-health");
  expect(r.status()).toBe(200);
  expect(r.headers()["cache-control"] || "", "never cached").toContain("no-store");
  const d = await r.json();
  for (const k of [...SHARED, ...SUPERADMIN_ONLY]) expect(d, `superadmin: ${k}`).toHaveProperty(k);
  expect(d.database_integrity_ok, "a healthy test database passed its check").toBe(true);
  expect(d.database_schema_ok).toBe(true);
  expect(d.maintenance).toBe(false);
  expect([true, false, null]).toContain(d.smtp_healthy);
  expect(Number.isInteger(d.uptime_seconds) && d.uptime_seconds >= 0).toBe(true);
  expect(typeof d.data_free_gib === "number" || d.data_free_gib === null).toBe(true);
  expect(d.event_retention_days).toBeGreaterThan(0);
  expect(d.node_version).toMatch(/^v\d+\./);
  expect(Number.isNaN(Date.parse(d.started_at)), "started_at is a time").toBe(false);
  expect(typeof d.database_size_mib === "number" || d.database_size_mib === null).toBe(true);
  expect(d.version, "the running version").toBe(require("../version.json").version);
  // The shared test server is no release image and mounts no backups: each fact
  // says so (built from a release image and a mounted folder: tests/about-health.spec.js).
  expect(d.build, "no build arguments: every part unknown").toEqual({ commit: null, built_at: null, channel: null });
  expect(d.backups, "no BACKUP_DIR: not visible, and why").toEqual({ visible: false, reason: "not_configured" });
  expect(d.smtp_checked_at, "no relay check runs under NODE_ENV=test").toBeNull();
  expectNoPath(d, "superadmin");
});

test("a regular admin gets the facts without the superadmin details", async () => {
  const { api, body } = await apiLogin(fx.admin.email);
  try {
    expect(body.role, "precondition: a regular admin").toBe("admin");
    const r = await api.get("/api/admin/system-health");
    expect(r.status(), await r.text()).toBe(200);
    const d = await r.json();
    for (const k of SHARED) expect(d, `admin: ${k}`).toHaveProperty(k);
    for (const k of SUPERADMIN_ONLY) expect(Object.keys(d), `admin: no ${k}`).not.toContain(k);
    expectNoPath(d, "admin");
  } finally { await api.dispose(); }
});

test("an event admin is refused", async () => {
  const { api } = await apiLogin(fx.ea.email);
  try {
    const me = await (await api.get("/api/admin/me")).json();
    expect(me.isEventAdmin, "precondition: an event admin").toBe(true);
    const r = await api.get("/api/admin/system-health");
    expect(r.status()).toBe(403);
    const d = await r.json();
    expect(d.code).toBe("event_admin_forbidden");
    for (const k of [...SHARED, ...SUPERADMIN_ONLY].filter((k) => k !== "version")) expect(Object.keys(d), `refused: no ${k}`).not.toContain(k);
  } finally { await api.dispose(); }
});
