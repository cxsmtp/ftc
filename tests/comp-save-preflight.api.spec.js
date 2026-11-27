// @ts-check
//
// v8.8.25 — THE SAVE ASKS BEFORE IT DESTROYS.
//
// `saveCompetition` makes up to nine requests, and the session bulk-delete
// COMMITS FIRST. It must: a multi->single switch cannot pass the competition PUT
// while its sessions still exist (v7.21.1 A4 ordered them that way for exactly
// that reason). So a PUT refused afterwards on ordinary input — a duplicate
// name, a kind-policy violation, a schedule the arithmetic rejects — left the
// sessions permanently gone. v8.3.20 made that failure NAME the deletion, which
// is honest and does not undo it.
//
// `validate_only` runs every pre-transaction refusal and returns without
// writing, so the client can ask first.
//
// THE SECOND FIELD IS WHAT MAKES THE FIRST CORRECT. A dry run run before the
// deletes answers about the PRE-DELETE world, and every slot-derived refusal
// reads the slot set those deletes are about to change — so without
// `delete_timeslot_ids` it is wrong in BOTH directions for precisely the save
// that creates the seam:
//
//   * FALSE REFUSAL — it refuses `trusted_networks_multi_session` /
//     `has_sessions` for a multi->single switch that becomes legal once the
//     sessions are gone; and
//   * FALSE CLEARANCE — it clears an edit on an event those deletes are about to
//     make ENDED.
//
// The third test is that false refusal, and it is the one a naive dry run fails.
//
// WHAT THIS DOES NOT CLAIM. Four refusals are raised INSIDE the server's write
// transaction (`lb_mode_locked`, `time_basis_locked`, `start_time_locked_in_use`,
// `staff_compete_locked` since v8.12.0)
// and are unreachable by any pre-flight by construction; the optimistic-
// concurrency 409 and the participant-footprint gate re-read live state. The
// seam is NARROWED, not closed, and the client keeps its "N session(s) were
// already removed" sentence for what remains.

const { test, expect } = require("./isolated-test");
const { apiLogin } = require("./helpers");

const H = (c) => ({ "x-csrf-token": c, "content-type": "application/json" });
const uniq = (l) => `${l}-${Date.now().toString(36)}-${Math.floor(Math.random() * 9973)}`;

test.describe("v8.8.25 — the competition save's pre-flight", () => {
  /** @type {any} */ let sa, csrf;

  test.beforeAll(async () => {
    test.setTimeout(180_000);
    const l = await apiLogin("superadmin");
    sa = l.api; csrf = l.csrf;
  });

  async function mkComp(name, extra = {}) {
    const r = await sa.post("/api/admin/competitions", {
      headers: H(csrf),
      data: {
        name,
        start_time: new Date(Date.now() + 3 * 24 * 3600_000).toISOString(),
        duration_minutes: 120,
        ...extra,
      },
    });
    expect(r.ok(), `create "${name}": ${r.status()} ${await r.text()}`).toBeTruthy();
    return (await r.json()).competition;
  }

  test("a dry run REFUSES a duplicate name and writes nothing", async () => {
    // The archetypal category-(a) refusal, and the one the client structurally
    // cannot self-check: it holds a filtered, paginated page of the list.
    const taken = await mkComp(uniq("Preflight Taken"));
    const mine = await mkComp(uniq("Preflight Mine"));

    const r = await sa.put(`/api/admin/competitions/${mine.id}`, {
      headers: H(csrf),
      data: {
        name: taken.name,
        start_time: mine.start_time,
        duration_minutes: 120,
        validate_only: true,
      },
    });
    expect(r.status(), "the dry run raises the same 409 the real save would").toBe(409);

    // …and NOTHING was written. Without this the test is satisfied by a build
    // that refuses after committing.
    const after = await sa.get("/api/admin/competitions");
    const row = (await after.json()).find(c => c.id === mine.id);
    expect(row.name, "the name is untouched").toBe(mine.name);
  });

  test("a dry run that PASSES writes nothing either", async () => {
    // The control the refusal test cannot supply: "nothing was written" is
    // equally true of a build whose dry run refuses everything.
    const c = await mkComp(uniq("Preflight Clean"));
    const newName = uniq("Preflight Renamed");

    const r = await sa.put(`/api/admin/competitions/${c.id}`, {
      headers: H(csrf),
      data: { name: newName, start_time: c.start_time, duration_minutes: 45, validate_only: true },
    });
    expect(r.status(), "a legal save validates").toBe(200);
    expect((await r.json()).validated, "…and says so").toBe(true);

    const after = await sa.get("/api/admin/competitions");
    const row = (await after.json()).find(x => x.id === c.id);
    expect(row.name, "the rename did NOT happen").toBe(c.name);
    expect(row.duration_minutes, "…and neither did the duration change").toBe(120);

    // …and the same body without the flag really does write, so the dry run is
    // refusing to act rather than merely failing to.
    const real = await sa.put(`/api/admin/competitions/${c.id}`, {
      headers: H(csrf),
      data: { name: newName, start_time: c.start_time, duration_minutes: 45, expectedUpdatedAt: row.updated_at },
    });
    expect(real.status(), `the real save: ${await real.text()}`).toBe(200);
    const after2 = await sa.get("/api/admin/competitions");
    expect((await after2.json()).find(x => x.id === c.id).name, "…it wrote this time").toBe(newName);
  });

  test("THE PROSPECTIVE SLOT SET — a multi->single switch validates only when the deletes are DECLARED", async () => {
    // This is the test a naive dry run fails, and the reason the second field
    // exists. `trusted_network_ips` is refused outright while the event holds
    // more than one session (v7.16.0), so the same body is illegal before the
    // deletes and legal after them.
    const c = await mkComp(uniq("Preflight Slots"));
    for (const label of ["Morning", "Afternoon"]) {
      const r = await sa.post(`/api/admin/competitions/${c.id}/timeslots`, {
        headers: H(csrf),
        data: {
          name: label,
          start_time: new Date(Date.now() + 3 * 24 * 3600_000).toISOString(),
          duration_minutes: 60,
        },
      });
      expect(r.ok(), `slot ${label}: ${r.status()} ${await r.text()}`).toBeTruthy();
    }
    const slots = await (await sa.get(`/api/admin/competitions/${c.id}/timeslots`)).json();
    const ids = (Array.isArray(slots) ? slots : slots.timeslots).map(s => String(s.id));
    expect(ids.length, "precondition: two sessions exist").toBe(2);

    const body = {
      name: c.name,
      start_time: c.start_time,
      duration_minutes: 120,
      trusted_network_ips: "198.51.100.0/24",
      validate_only: true,
    };

    // Without the declaration the server sees two sessions and refuses — which
    // is the correct answer about the world it was shown, and the WRONG answer
    // about the save being attempted.
    const blind = await sa.put(`/api/admin/competitions/${c.id}`, { headers: H(csrf), data: body });
    expect(blind.status(), "a dry run blind to the deletes refuses").toBe(400);
    expect((await blind.json()).code).toBe("trusted_networks_multi_session");

    // Declared, the same body validates.
    const seeing = await sa.put(`/api/admin/competitions/${c.id}`, {
      headers: H(csrf), data: { ...body, delete_timeslot_ids: ids },
    });
    expect(seeing.status(), `declared: ${await seeing.text()}`).toBe(200);

    // …and declaring the deletes did not PERFORM them.
    const still = await (await sa.get(`/api/admin/competitions/${c.id}/timeslots`)).json();
    const stillIds = (Array.isArray(still) ? still : still.timeslots).map(s => String(s.id));
    expect(stillIds.length, "a dry run deletes nothing").toBe(2);
  });

  test("CONTROL — declaring deletes does not weaken a refusal that has nothing to do with slots", async () => {
    // Without this, "declaring the deletes made it pass" is equally satisfied by
    // a build where the declaration disables validation wholesale.
    const taken = await mkComp(uniq("Preflight Ctl Taken"));
    const c = await mkComp(uniq("Preflight Ctl"));
    const r = await sa.put(`/api/admin/competitions/${c.id}`, {
      headers: H(csrf),
      data: {
        name: taken.name,
        start_time: c.start_time,
        duration_minutes: 120,
        validate_only: true,
        delete_timeslot_ids: ["not-a-real-slot", "another"],
      },
    });
    expect(r.status(), "the duplicate name is still refused").toBe(409);
  });

  test("CONTROL — an ordinary save is unchanged by the new fields", async () => {
    // The fields are optional and absent from every existing caller, so a save
    // that sends neither must behave exactly as it did.
    const c = await mkComp(uniq("Preflight Untouched"));
    const list = await (await sa.get("/api/admin/competitions")).json();
    const row = list.find(x => x.id === c.id);
    const r = await sa.put(`/api/admin/competitions/${c.id}`, {
      headers: H(csrf),
      data: { name: c.name, start_time: c.start_time, duration_minutes: 90, expectedUpdatedAt: row.updated_at },
    });
    expect(r.status(), `${await r.text()}`).toBe(200);
    const after = await (await sa.get("/api/admin/competitions")).json();
    expect(after.find(x => x.id === c.id).duration_minutes, "it wrote").toBe(90);
  });
});
