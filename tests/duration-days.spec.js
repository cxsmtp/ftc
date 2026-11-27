// v8.1.0 — PR 17: formatDuration carries days, and a multi-day event says which
// day it is on.
//
// Split out from the Program work deliberately: this is a change to a SHIPPING
// surface, not a Program feature. `formatDuration` is HH:MM:SS with unbounded
// hours at ten call sites including the participant header countdown and the
// admin Duration COLUMN, so a five-day Competition read `119:44:12` and a ten-year
// Program would have read `87672:00:00`. Burying that inside a ten-part Program PR
// would review its blast radius as an afterthought.
//
// Q3 answered (b): the duration change alone still does not tell a participant
// what they actually want to know on the third morning, so the day chip ships
// with it.
const { test, expect } = require("./isolated-test");
const { registerPost } = require("./helpers");
const { freshCtx, getSuperadminPass, BASE, PARTICIPANT_PASS, codeLogin } = require("./helpers");

test.use({ baseURL: BASE });

const H = (csrf) => ({ "x-csrf-token": csrf, "content-type": "application/json" });
const TAG = `dd${Date.now().toString(36)}`;

test.describe("v8.1.0 — durations carry days", () => {
  test("under a day is byte-identical; a day or more grows a days field", async ({ page }) => {
    await page.goto("/");
    const out = await page.evaluate(() => ({
      zero:   window.formatDuration(0),
      m59:    window.formatDuration(59 * 60000),
      h23:    window.formatDuration(86399000),
      d1:     window.formatDuration(86400000),
      d5:     window.formatDuration(119 * 3600000 + 44 * 60000 + 12000),
      decade: window.formatDuration(5260320 * 60000),
    }));
    // EVERY sub-24h rendering is unchanged to the character — the live countdown,
    // the urgency classes at 60 s and 10 s, and every session duration cell.
    expect(out.zero).toBe("00:00:00");
    expect(out.m59).toBe("00:59:00");
    expect(out.h23).toBe("23:59:59");
    // …and at a day the field appears rather than the hours running away.
    expect(out.d1).toBe("1d 00:00:00");
    expect(out.d5).toBe("4d 23:44:12");
    expect(out.decade, "a ten-year Program is legible instead of five digits of hours").toBe("3653d 00:00:00");
    expect(out.decade).not.toContain("87672");
  });

  test("dayOfSpan counts from the START, clamps at the end, and stays silent under two days", async ({ page }) => {
    await page.goto("/");
    const D = 86400000;
    const r = await page.evaluate((D) => ({
      oneDay:   window.dayOfSpan(0, D, 0),
      twoDay:   window.dayOfSpan(0, 2 * D, 0),
      mid:      window.dayOfSpan(0, 5 * D, 2.5 * D),
      last:     window.dayOfSpan(0, 5 * D, 4.9 * D),
      past:     window.dayOfSpan(0, 5 * D, 9 * D),
      // Days are counted from the START, not from midnight: an event beginning at
      // 14:00 Monday is on day 2 at 14:00 Tuesday, which is what someone counting
      // sessions means. A calendar rule would flip mid-evening while everyone is
      // still working on what they call day one.
      afternoon: window.dayOfSpan(0, 5 * D, 1.9 * D),
      nan:      window.dayOfSpan(NaN, 5 * D, 0),
      // Epoch 0 is a LEGITIMATE start. A truthiness guard rejects it, which is the
      // kind of falsiness bug real data never trips.
      epoch:    window.dayOfSpan(0, 3 * D, 0),
    }), D);
    expect(r.oneDay, "a single-day event has no day N of M to report").toBeNull();
    expect(r.twoDay).toEqual({ day: 1, total: 2 });
    expect(r.mid).toEqual({ day: 3, total: 5 });
    expect(r.last).toEqual({ day: 5, total: 5 });
    expect(r.past, "past the end it clamps rather than counting on").toEqual({ day: 5, total: 5 });
    expect(r.afternoon).toEqual({ day: 2, total: 5 });
    expect(r.nan).toBeNull();
    expect(r.epoch).toEqual({ day: 1, total: 3 });
  });

  test("a participant in a MULTI-DAY competition sees the day chip; a one-day one does not", async ({ page }) => {
    const { api, csrf: c0 } = await freshCtx();
    const lr = await api.post("/api/login", { headers: H(c0), data: { email: "superadmin", password: getSuperadminPass() } });
    expect(lr.ok()).toBeTruthy();
    const csrf = (await (await api.get("/api/csrf-token")).json()).csrfToken;
    let papi;
    try {
      const mk = async (label, durationMinutes) => {
        const r = await api.post("/api/admin/competitions", {
          headers: H(csrf),
          data: {
            name: `${TAG} ${label}`,
            // Started 2.5 days ago so the chip has a real answer to give.
            start_time: new Date(Date.now() - 2.5 * 86400000).toISOString(),
            duration_minutes: durationMinutes, timezone: "UTC",
          },
        });
        expect(r.ok(), `create ${label}: ${await r.text()}`).toBeTruthy();
        return (await r.json()).competition.id;
      };
      const week = await mk("Week", 7 * 24 * 60);       // 7 days → multi-day
      const short = await mk("Short", 4 * 24 * 60);     // still multi-day; see below

      const email = `${TAG}@company.example`;
      const reg = await registerPost(api, "/api/register", {
        headers: H(csrf),
        data: {
          firstName: "Day", lastName: "Chip", nickname: `${TAG}_p`, email,
          company: "Acme", title: "Engineer", country: "US", timezone: "America/New_York",
          password: PARTICIPANT_PASS, jobFunction: "Software Developer / Engineer", city: "Testville",
        },
      });
      expect(reg.status(), await reg.text()).toBe(200);
      const list = await (await api.get(`/api/admin/participants?limit=500&search=${encodeURIComponent(email)}`)).json();
      const u = (list.participants || []).find(p => p.email === email);
      await api.post(`/api/admin/participants/${u.id}/verify`, { headers: H(csrf) });
      await api.post(`/api/admin/participants/${u.id}/approve`, { headers: H(csrf) });
      const asg = await api.post("/api/admin/competitions/assign", {
        headers: H(csrf), data: { userIds: [String(u.id)], competitionIds: [week, short] },
      });
      expect(asg.ok(), `assign: ${await asg.text()}`).toBeTruthy();
      expect((await asg.json()).assigned).toBeGreaterThan(0);

      const { csrfToken } = await (await page.request.get("/api/csrf-token")).json();
      const li = await codeLogin(page.request, email, H(csrfToken));
      expect(li.ok(), `participant login: ${await li.text()}`).toBeTruthy();
      await page.goto("/");
      const pcsrf = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
      const sel = await page.request.post("/api/select-competition", { headers: H(pcsrf), data: { competitionId: week } });
      expect(sel.ok(), `select: ${await sel.text()}`).toBeTruthy();
      await page.reload();

      const chip = page.locator("#header-day");
      await expect.poll(() => chip.textContent(), { timeout: 15000 }).toMatch(/Day 3 of 7/);
      await expect(chip).toBeVisible();
      // The countdown beside it carries days too, rather than four digits of hours.
      await expect.poll(() => page.locator("#header-timer").textContent(), { timeout: 10000 })
        .toMatch(/^\d+d \d\d:\d\d:\d\d$/);

      // The negative control: a competition SHORTER than two days must render no
      // chip at all, or "the chip appears" is satisfied by one that always does.
      papi = (await freshCtx()).api;
      const oneDay = await api.post("/api/admin/competitions", {
        headers: H(csrf),
        data: { name: `${TAG} OneDay`, start_time: new Date(Date.now() - 3600e3).toISOString(), duration_minutes: 600, timezone: "UTC" },
      });
      expect(oneDay.ok()).toBeTruthy();
      const oneDayId = (await oneDay.json()).competition.id;
      const asg2 = await api.post("/api/admin/competitions/assign", {
        headers: H(csrf), data: { userIds: [String(u.id)], competitionIds: [oneDayId] },
      });
      expect(asg2.ok()).toBeTruthy();
      const sel2 = await page.request.post("/api/select-competition", { headers: H(pcsrf), data: { competitionId: oneDayId } });
      expect(sel2.ok(), `select one-day: ${await sel2.text()}`).toBeTruthy();
      await page.reload();
      await expect.poll(() => page.locator("#header-timer").textContent(), { timeout: 15000 })
        .toMatch(/^\d\d:\d\d:\d\d$/);
      await expect(chip, "a sub-two-day event shows no day chip").toBeHidden();
    } finally {
      await api.dispose();
      if (papi) await papi.dispose();
    }
  });
});
