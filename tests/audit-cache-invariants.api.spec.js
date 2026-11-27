// @ts-check
// Audit rerun fixes — cache / invariant correctness (CTF-0002).
//   #2 timeslot writers bust the competition cache (optimistic-concurrency 409)
//   #9 staff-tag add busts the target's /api/me cache (isStaff freshness)
//   #8 participant import applies the staff tag to admins/superadmins
const { test, expect } = require("./isolated-test");
const { registerPost } = require("./helpers");
const { apiLogin, freshCtx, PARTICIPANT_PASS, BASE, TEST_DB_PATH } = require("./helpers");

test.use({ baseURL: BASE });
const h = (csrf) => ({ "x-csrf-token": csrf, "content-type": "application/json" });

test.describe("Audit rerun — cache/invariant correctness", () => {
  test("#2: a timeslot mutation busts the competition cache so a stale comp-PUT 409s", async () => {
    const { api, csrf } = await apiLogin("superadmin");
    const H = h(csrf);
    // Upcoming comp, no timeslots yet. Capture its updated_at (T0).
    const cr = await api.post("/api/admin/competitions", { headers: H, data: {
      name: `TsCache-${Date.now()}`, start_time: new Date(Date.now() + 3600_000).toISOString(), duration_minutes: 120,
    }});
    const comp = (await cr.json()).competition;
    const staleUpdatedAt = comp.updated_at;
    expect(typeof staleUpdatedAt).toBe("string");

    // Creating a timeslot bumps competitions.updated_at (→ T1) and must bust the cache.
    const ts = await api.post(`/api/admin/competitions/${comp.id}/timeslots`, { headers: H, data: {
      name: "Slot A", start_time: new Date(Date.now() + 3600_000).toISOString(), duration_minutes: 60,
    }});
    expect(ts.ok()).toBeTruthy();

    // A concurrent admin still holding T0 edits the comp → must be rejected (409),
    // not silently win against a cached old updated_at.
    const put = await api.put(`/api/admin/competitions/${comp.id}`, { headers: H, data: {
      name: "Renamed By Stale Editor", expectedUpdatedAt: staleUpdatedAt,
    }});
    expect(put.status()).toBe(409);
    await api.dispose();
  });

  test("#9: adding the staff tag busts the target participant's /api/me cache", async () => {
    // Fresh participant for full isolation from other staff-tag tests.
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = h(saCsrf);
    const stamp = `${Date.now()}-${Math.floor(process.hrtime()[1] / 1000)}`;
    const email = `staffcache-${stamp}@acme.com`;
    await registerPost(sa, "/api/register", { headers: saH, data: {
      firstName: "Staff", lastName: "Cache", nickname: `staffcache_${stamp}`, email,
      company: "Acme", title: "Engineer", avatar: "🦊", country: "US", timezone: "America/New_York",
      jobFunction: "Software Developer / Engineer", city: "New York",
    }});
    const all = await (await sa.get("/api/admin/participants?limit=2000")).json();
    const u = all.participants.find(p => p.email === email);
    if (!u.verified) await sa.post(`/api/admin/participants/${u.id}/verify`, { headers: saH });
    if (!u.approved) await sa.post(`/api/admin/participants/${u.id}/approve`, { headers: saH });

    // Participant primes their /api/me cache (isStaff:false).
    const { api: pa, csrf: pc } = await apiLogin(email, PARTICIPANT_PASS);
    expect((await (await pa.get("/api/me")).json()).isStaff).toBe(false);

    // Admin tags them staff. Re-fetch within the 2s cache window — must reflect immediately.
    await sa.post(`/api/admin/participants/${u.id}/tags`, { headers: saH, data: { tag: "staff" } });
    expect((await (await pa.get("/api/me")).json()).isStaff).toBe(true);

    await pa.dispose();
    await sa.dispose();
  });

  test("#8: importing a participant with role=admin applies the staff tag", async () => {
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = h(saCsrf);
    const stamp = `${Date.now()}-${Math.floor(process.hrtime()[1] / 1000)}`;
    const email = `importadmin-${stamp}@acme.com`;
    const row = {
      nickname: `importadmin_${stamp}`, email, first_name: "Imp", last_name: "Admin",
      company: "Acme", title: "Lead", country: "US", timezone: "America/New_York",
      job_function: "Software Developer / Engineer", city: "NYC",
      role: "admin", verified: 1, approved: 1,
      // deliberately NO "staff" in tags — the import must add it from the role.
      tags: [],
    };
    const imp = await sa.post("/api/admin/import/participants", {
      headers: saH, data: { data: { type: "hackarena-participants", version: 2, participants: [row] }, resolutions: {} },
    });
    expect(imp.ok(), `import: ${imp.status()} ${await imp.text().catch(() => "")}`).toBeTruthy();

    // Verify via a read-only DB snapshot that the imported admin carries the staff tag.
    const Database = require("better-sqlite3");
    const dbRO = new Database(TEST_DB_PATH, { readonly: true });
    try {
      const u = dbRO.prepare("SELECT id, role FROM users WHERE email=?").get(email);
      expect(u, "imported user exists").toBeTruthy();
      expect(u.role).toBe("admin");
      const staff = dbRO.prepare("SELECT 1 FROM user_tags WHERE user_id=? AND tag='staff'").get(u.id);
      expect(staff, "imported admin has the staff tag").toBeTruthy();
    } finally {
      dbRO.close();
    }
    await sa.dispose();
  });
});
