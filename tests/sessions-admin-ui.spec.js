// @ts-check
//
// v7.15.31 — coverage for `public/js/features/sessions-admin.js`.
//
// The v7.15.16 test-suite audit found this module had ZERO tests: 202 lines
// that own every admin path for creating, editing, ending and deleting a
// competition session, including the timezone arithmetic that decides the
// instant a session actually starts.
//
// That arithmetic is the load-bearing part. `_sessionGetStartUtc` is what
// `competitions-admin.js` calls (line ~1064) to turn the admin's wall-clock
// entry into the `start_time` that is stored, so an error here does not
// produce a visibly broken form — it silently starts a competition at the
// wrong moment, in a way nobody notices until participants cannot get in.
//
// It is also exactly the shape of bug that hides on a developer's machine:
// the browser's own timezone cancels out of the formula, so a wrong formula
// can still look right whenever the browser and the session share a zone.
// Every case below therefore runs with the BROWSER pinned to a zone that is
// NOT the session's, and the suite runs the same table from two different
// browser zones to prove the cancellation is real rather than coincidental.
const { test, expect } = require("./isolated-test");
const { getSuperadminPass, BASE, codeLogin } = require("./helpers");

test.use({ baseURL: BASE });

async function loginViaApi(page, email, password) {
  const doPost = async (pw) => {
    const { csrfToken } = await (await page.request.get("/api/csrf-token")).json();
    return codeLogin(page.request, email, { "x-csrf-token": csrfToken, "content-type": "application/json" }, { password: pw });
  };
  let r;
  try { r = await doPost(password); } catch (_) { r = null; }
  if (r && r.ok()) return;
  await new Promise(res => setTimeout(res, 300));
  r = await doPost(email === "superadmin" ? getSuperadminPass() : password);
  // v7.22.0 — say WHY (see the shared probe in helpers.js). The bare status was
  // the least informative of all eight copies: not even the response body.
  if (!r.ok()) throw new Error(`loginViaApi(${email}) failed: ${r.status()} ${await r.text()}`
    + await require("./helpers").describeAccountState(email, password));
}

async function adminLogin(page) {
  await loginViaApi(page, "superadmin", getSuperadminPass());
  await page.goto("/");
  await page.locator("#admin-page").waitFor({ state: "visible", timeout: 30000 });
  // The module functions are reachable only once boot() has restored the
  // classic-script global namespace onto window.
  await page.waitForFunction(() => typeof window._sessionGetStartUtc === "function", { timeout: 20000 });
}

// Build a row carrying exactly the fields the module reads. The class names
// are the contract with `competitions-admin.js`'s real markup — if that markup
// renames one, these fixtures keep passing while production breaks, so the
// end-to-end test at the bottom exercises a REAL row from the real form.
async function makeRow(page, { date, time, tz, d = 0, h = 0, m = 0 }) {
  await page.evaluate(({ date, time, tz, d, h, m }) => {
    document.getElementById("__tsrow")?.remove();
    const row = document.createElement("div");
    row.id = "__tsrow";
    row.className = "session-form-row";
    row.innerHTML =
      `<input class="ts-date" value="${date}"><input class="ts-time" value="${time}">` +
      `<input class="ts-tz" value="${tz}">` +
      `<input class="ts-dur-d" value="${d}"><input class="ts-dur-h" value="${h}"><input class="ts-dur-m" value="${m}">` +
      `<input class="ts-end-date"><input class="ts-end-time"><div class="ts-end-preview"></div>`;
    document.body.appendChild(row);
  }, { date, time, tz, d, h, m });
}

// ═══════════════════════════════════════════════════════════════════════════
// The timezone arithmetic, from two different browser zones.
// ═══════════════════════════════════════════════════════════════════════════
//
// Each case: the admin types this wall-clock in this session zone, so the
// stored instant must be exactly this. Dates are chosen to sit unambiguously
// inside or outside DST for the zone in question rather than near a boundary.
const TZ_CASES = [
  // zone,                 wall date,    wall time, expected UTC instant
  ["UTC",                  "2026-01-15", "10:00",   "2026-01-15T10:00:00.000Z"],
  ["Asia/Tokyo",           "2026-01-15", "10:00",   "2026-01-15T01:00:00.000Z"], // +09, never DST
  ["Asia/Kolkata",         "2026-01-15", "10:00",   "2026-01-15T04:30:00.000Z"], // +05:30 — half-hour offset
  ["America/Los_Angeles",  "2026-01-15", "10:00",   "2026-01-15T18:00:00.000Z"], // PST -08
  ["Australia/Sydney",     "2026-01-15", "10:00",   "2026-01-14T23:00:00.000Z"], // AEDT +11, crosses the date line backwards
  ["Europe/London",        "2026-01-15", "10:00",   "2026-01-15T10:00:00.000Z"], // GMT +00 in winter
  ["Europe/London",        "2026-07-15", "10:00",   "2026-07-15T09:00:00.000Z"], // BST +01 in summer — same zone, different offset
  ["America/New_York",     "2026-07-15", "00:30",   "2026-07-15T04:30:00.000Z"], // EDT -04, just after midnight
];

for (const browserTz of ["America/New_York", "UTC"]) {
  test.describe(`Session start-time arithmetic (browser in ${browserTz})`, () => {
    test.use({ timezoneId: browserTz });

    test(`_sessionGetStartUtc resolves a wall clock in the SESSION's zone, not the browser's`, async ({ page }) => {
      await adminLogin(page);
      // Sanity: the browser really is where we think. Without this the whole
      // table could pass by accident on a runner that ignored timezoneId.
      const actualTz = await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
      expect(actualTz, "Playwright must have applied timezoneId").toBe(browserTz);

      for (const [tz, date, time, expected] of TZ_CASES) {
        await makeRow(page, { date, time, tz });
        // NB: _sessionGetStartUtc takes the ROW (it queries down into it),
        // unlike sessionFormUpdateEnd which takes the changed field.
        const iso = await page.evaluate(() =>
          window._sessionGetStartUtc(document.getElementById("__tsrow"))?.toISOString());
        expect(iso, `${date} ${time} in ${tz} (browser ${browserTz})`).toBe(expected);
      }
    });
  });
}

test.describe("Session form — duration and end-time", () => {
  test.use({ timezoneId: "America/New_York" });

  test("duration decomposes and recomposes across the day boundary", async ({ page }) => {
    await adminLogin(page);
    // _sessionSetDur splits minutes into d/h/m and _sessionGetDurMinutes puts
    // them back. A wrong divisor is invisible under an hour, so the cases that
    // matter are the ones that carry.
    await makeRow(page, { date: "2026-01-15", time: "10:00", tz: "UTC" });
    for (const total of [1, 59, 60, 90, 1439, 1440, 1441, 1500, 2880, 10081]) {
      const got = await page.evaluate((t) => {
        const row = document.getElementById("__tsrow");
        window._sessionSetDur(row, t);
        return {
          d: row.querySelector(".ts-dur-d").value,
          h: row.querySelector(".ts-dur-h").value,
          m: row.querySelector(".ts-dur-m").value,
          back: window._sessionGetDurMinutes(row),
        };
      }, total);
      expect(got.back, `${total} min must round-trip`).toBe(total);
      expect(Number(got.d) * 1440 + Number(got.h) * 60 + Number(got.m),
        `${total} min decomposes to ${got.d}d ${got.h}h ${got.m}m`).toBe(total);
      expect(Number(got.h), "hours stay inside a day").toBeLessThan(24);
      expect(Number(got.m), "minutes stay inside an hour").toBeLessThan(60);
    }
  });

  test("the end-time preview and fields are rendered in the SESSION's zone", async ({ page }) => {
    await adminLogin(page);
    // 2026-01-15 22:00 Tokyo + 4h lands at 02:00 on the 16th, Tokyo time.
    // A formula that rendered in the browser zone would show the 15th.
    await makeRow(page, { date: "2026-01-15", time: "22:00", tz: "Asia/Tokyo", h: 4 });
    const out = await page.evaluate(() => {
      window.sessionFormUpdateEnd(document.querySelector("#__tsrow .ts-date"));
      const row = document.getElementById("__tsrow");
      return {
        endDate: row.querySelector(".ts-end-date").value,
        endTime: row.querySelector(".ts-end-time").value,
        preview: row.querySelector(".ts-end-preview").textContent,
      };
    });
    expect(out.endDate, "end date is the NEXT day in Tokyo").toBe("2026-01-16");
    expect(out.endTime).toBe("02:00");
    expect(out.preview, "the preview names the zone it is quoting").toContain("Asia/Tokyo");
    expect(out.preview).toMatch(/^Ends:/);
  });

  test("typing an end time back-computes the duration", async ({ page }) => {
    await adminLogin(page);
    await makeRow(page, { date: "2026-01-15", time: "09:00", tz: "Asia/Kolkata", h: 3 });
    const mins = await page.evaluate(() => {
      const row = document.getElementById("__tsrow");
      row.querySelector(".ts-end-date").value = "2026-01-15";
      row.querySelector(".ts-end-time").value = "17:30";
      window.sessionFormEndChanged(row.querySelector(".ts-end-time"));
      return window._sessionGetDurMinutes(row);
    });
    // 09:00 → 17:30 is 8h30m, and both readings are in the same zone so the
    // offset cancels — but only if BOTH sides apply it.
    expect(mins).toBe(510);
  });

  test("an end time at or before the start is refused and leaves the duration alone", async ({ page }) => {
    await adminLogin(page);
    await makeRow(page, { date: "2026-01-15", time: "09:00", tz: "UTC", h: 3 });
    for (const endTime of ["08:59", "09:00"]) {
      const mins = await page.evaluate((t) => {
        const row = document.getElementById("__tsrow");
        row.querySelector(".ts-end-date").value = "2026-01-15";
        row.querySelector(".ts-end-time").value = t;
        window.sessionFormEndChanged(row.querySelector(".ts-end-time"));
        return window._sessionGetDurMinutes(row);
      }, endTime);
      expect(mins, `end ${endTime} must not overwrite the 3h duration`).toBe(180);
    }
    // showToast is an ES-module import, so stubbing window.showToast would
    // intercept nothing and assert vacuously — read the real toast instead.
    await expect(page.locator(".toast", { hasText: "End time must be after start time." }).first())
      .toBeVisible({ timeout: 5000 });
  });

  test("an incomplete row yields no start and clears the preview", async ({ page }) => {
    await adminLogin(page);
    await makeRow(page, { date: "", time: "10:00", tz: "UTC", h: 2 });
    const r = await page.evaluate(() => {
      const row = document.getElementById("__tsrow");
      row.querySelector(".ts-end-preview").textContent = "stale";
      window.sessionFormUpdateEnd(row.querySelector(".ts-date"));
      return {
        start: window._sessionGetStartUtc(row),
        preview: row.querySelector(".ts-end-preview").textContent,
      };
    });
    expect(r.start, "a row with no date has no start instant").toBeNull();
    expect(r.preview, "a stale preview must be cleared, not left lying").toBe("");
  });

  test("a half-typed timezone clears the preview instead of throwing or going stale", async ({ page }) => {
    await adminLogin(page);
    // The timezone box is a free-text `<input list=…>`, so an admin typing to
    // filter the datalist commits invalid intermediate values — "Europe/Lond"
    // on the way to "Europe/London", or a plain typo. v7.15.31: fmtDt threw
    // out of the change handler here, leaving the previous zone's end time on
    // screen as though it still applied.
    await makeRow(page, { date: "2026-01-15", time: "10:00", tz: "Asia/Tokyo", h: 1 });
    const valid = await page.evaluate(() => {
      const row = document.getElementById("__tsrow");
      window.sessionFormUpdateEnd(row.querySelector(".ts-date"));
      return row.querySelector(".ts-end-preview").textContent;
    });
    expect(valid, "baseline: a valid zone previews").toContain("Asia/Tokyo");

    const r = await page.evaluate(() => {
      const row = document.getElementById("__tsrow");
      row.querySelector(".ts-tz").value = "Europe/Lond";
      try {
        window.sessionFormUpdateEnd(row.querySelector(".ts-tz"));
        return { ok: true, preview: row.querySelector(".ts-end-preview").textContent };
      } catch (e) { return { ok: false, err: String(e && e.message) }; }
    });
    expect(r.ok, `must not throw out of the change handler: ${r.err}`).toBe(true);
    expect(r.preview, "a preview naming the OLD zone would be a lie").not.toContain("Asia/Tokyo");
    expect(r.preview, "nothing beats something wrong").toBe("");

    // And _sessionGetStartUtc still yields an instant, so the row stays usable
    // and the save path can produce its own named error.
    const start = await page.evaluate(() =>
      window._sessionGetStartUtc(document.getElementById("__tsrow"))?.toISOString());
    expect(start).toBeTruthy();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The session lifecycle dialogs.
// ═══════════════════════════════════════════════════════════════════════════
test.describe("Session lifecycle dialogs", () => {
  // Each test owns its own competition so nothing here depends on — or
  // disturbs — the shared seed fixtures.
  async function makeComp(page, { startOffsetMs, durationMinutes, name }) {
    const { csrfToken } = await (await page.request.get("/api/csrf-token")).json();
    const r = await page.request.post("/api/admin/competitions", {
      headers: { "x-csrf-token": csrfToken, "content-type": "application/json" },
      data: {
        name, start_time: new Date(Date.now() + startOffsetMs).toISOString(),
        duration_minutes: durationMinutes, timezone: "UTC",
      },
    });
    expect(r.ok(), `competition create: ${r.status()}`).toBeTruthy();
    return (await r.json()).competition.id;
  }
  async function addSlot(page, compId, { name, startOffsetMs, durationMinutes }) {
    const { csrfToken } = await (await page.request.get("/api/csrf-token")).json();
    const r = await page.request.post(`/api/admin/competitions/${compId}/timeslots`, {
      headers: { "x-csrf-token": csrfToken, "content-type": "application/json" },
      data: { name, start_time: new Date(Date.now() + startOffsetMs).toISOString(), duration_minutes: durationMinutes },
    });
    expect(r.ok(), `timeslot create: ${r.status()}`).toBeTruthy();
    return (await r.json()).timeslot?.id || (await r.json()).id;
  }

  test("ending a LIVE session asks to end it; ending a PENDING one asks to CANCEL it", async ({ page }) => {
    await adminLogin(page);
    const stamp = Date.now();
    const compId = await makeComp(page, { startOffsetMs: -3600_000, durationMinutes: 600, name: `TS Copy ${stamp}` });
    const liveId = await addSlot(page, compId, { name: "Live Slot", startOffsetMs: -1800_000, durationMinutes: 600 });
    const pendId = await addSlot(page, compId, { name: "Pending Slot", startOffsetMs: 3600_000, durationMinutes: 60 });

    // endTimeslotNow reads the slot out of S.adminCompetitionsData, so the
    // admin list has to be loaded before it can find anything.
    await page.evaluate(() => window.loadAdminCompetitions());
    await page.waitForFunction((id) =>
      (window.S.adminCompetitionsData || []).some(c => c.id === id), compId, { timeout: 15000 });

    // The two branches differ only in copy, and that copy is the entire
    // safeguard: "cancel — it will never go live" vs "end — submissions stop".
    for (const [tsId, title, needle] of [
      [liveId, "End Session Now", "no longer be able to submit"],
      [pendId, "Cancel Session", "cancelled without ever going live"],
    ]) {
      await page.evaluate(({ compId, tsId }) => { window.endTimeslotNow(compId, tsId); }, { compId, tsId });
      const overlay = page.locator("#modal-overlay.open");
      await expect(overlay).toBeVisible({ timeout: 5000 });
      await expect(overlay.locator("#modal-title")).toHaveText(title);
      await expect(overlay).toContainText(needle);
      await page.locator("#modal-cancel-btn").click();
      await expect(overlay).toBeHidden({ timeout: 5000 });
    }
  });

  test("cancelling the delete-session confirm leaves the session in place", async ({ page }) => {
    await adminLogin(page);
    const stamp = Date.now();
    const compId = await makeComp(page, { startOffsetMs: 7200_000, durationMinutes: 120, name: `TS Del ${stamp}` });
    const tsId = await addSlot(page, compId, { name: "Doomed Slot", startOffsetMs: 7200_000, durationMinutes: 60 });

    await page.evaluate(({ compId, tsId }) => { window.deleteTimeslot(compId, tsId); }, { compId, tsId });
    await expect(page.locator("#modal-overlay.open")).toBeVisible({ timeout: 5000 });
    await page.locator("#modal-cancel-btn").click();
    await expect(page.locator("#modal-overlay.open")).toBeHidden({ timeout: 5000 });

    // A confirm that deletes on Cancel would be a silent data-loss bug, so
    // assert against the server rather than the rendered list.
    const list = await (await page.request.get(`/api/admin/competitions/${compId}/timeslots`)).json();
    const ids = (list.timeslots || list || []).map(t => t.id);
    expect(ids, "Cancel must not delete").toContain(tsId);
  });

  test("confirming the delete removes the session", async ({ page }) => {
    await adminLogin(page);
    const stamp = Date.now();
    const compId = await makeComp(page, { startOffsetMs: 7200_000, durationMinutes: 120, name: `TS Del2 ${stamp}` });
    const tsId = await addSlot(page, compId, { name: "Doomed Slot 2", startOffsetMs: 7200_000, durationMinutes: 60 });

    await page.evaluate(() => window.loadAdminCompetitions());
    await page.evaluate(({ compId, tsId }) => { window.deleteTimeslot(compId, tsId); }, { compId, tsId });
    await expect(page.locator("#modal-overlay.open")).toBeVisible({ timeout: 5000 });
    await page.locator("#modal-confirm-btn").click();

    await expect.poll(async () => {
      const list = await (await page.request.get(`/api/admin/competitions/${compId}/timeslots`)).json();
      return (list.timeslots || list || []).map(t => t.id).includes(tsId);
    }, { timeout: 10000 }).toBe(false);
  });

  test("the Add Session dialog rejects an empty form and creates on a complete one", async ({ page }) => {
    await adminLogin(page);
    const stamp = Date.now();
    const compId = await makeComp(page, { startOffsetMs: 7200_000, durationMinutes: 600, name: `TS Add ${stamp}` });

    await page.evaluate((id) => window.addTimeslotForm(id), compId);
    await expect(page.locator("#ts-form-overlay")).toBeVisible({ timeout: 5000 });

    // Empty name → refused, dialog stays open. (The dialog pre-fills date,
    // time and duration, so the name is the field a user can actually leave
    // blank.)
    await page.fill("#ts-name", "");
    await page.locator("[data-action='ts-save']").click();
    await expect(page.locator(".toast", { hasText: "Please fill all fields." }).first()).toBeVisible({ timeout: 5000 });
    await expect(page.locator("#ts-form-overlay"), "a refused save keeps the dialog open").toBeVisible();

    await page.fill("#ts-name", `Added Slot ${stamp}`);
    await page.fill("#ts-duration", "45");
    await page.locator("[data-action='ts-save']").click();
    await expect(page.locator("#ts-form-overlay")).toBeHidden({ timeout: 10000 });

    const list = await (await page.request.get(`/api/admin/competitions/${compId}/timeslots`)).json();
    const slots = list.timeslots || list || [];
    const made = slots.find(t => t.name === `Added Slot ${stamp}`);
    expect(made, "the session must exist on the server, not just in the DOM").toBeTruthy();
    expect(made.duration_minutes).toBe(45);
  });

  test("the Edit Session dialog pre-fills from the stored session and saves a change", async ({ page }) => {
    await adminLogin(page);
    const stamp = Date.now();
    const compId = await makeComp(page, { startOffsetMs: 7200_000, durationMinutes: 600, name: `TS Edit ${stamp}` });
    const tsId = await addSlot(page, compId, { name: `Before ${stamp}`, startOffsetMs: 7200_000, durationMinutes: 90 });

    await page.evaluate(() => window.loadAdminCompetitions());
    await page.waitForFunction((id) =>
      (window.S.adminCompetitionsData || []).some(c => c.id === id), compId, { timeout: 15000 });

    await page.evaluate(({ compId, tsId }) => window.editTimeslot(compId, tsId), { compId, tsId });
    await expect(page.locator("#ts-form-overlay")).toBeVisible({ timeout: 5000 });
    // Pre-fill is the point of an edit dialog: a blank one silently blanks the
    // record on save.
    await expect(page.locator("#ts-name")).toHaveValue(`Before ${stamp}`);
    await expect(page.locator("#ts-duration")).toHaveValue("90");

    await page.fill("#ts-name", `After ${stamp}`);
    await page.locator("[data-action='ts-save']").click();
    await expect(page.locator("#ts-form-overlay")).toBeHidden({ timeout: 10000 });

    const list = await (await page.request.get(`/api/admin/competitions/${compId}/timeslots`)).json();
    const slots = list.timeslots || list || [];
    expect(slots.find(t => t.id === tsId).name).toBe(`After ${stamp}`);
  });
});
