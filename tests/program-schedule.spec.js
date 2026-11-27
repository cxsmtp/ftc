// v8.1.0 — PR 16: a Program runs to a DEADLINE, and does not close itself.
//
// Two columns landed inert in PR 11 and become live here. The second is the one
// that matters: `auto_end_on_all_solved` existed and NOTHING read it, so a Program
// would have auto-ended the moment its first enrollee finished — closed to
// everyone after them on the one kind built for rolling enrolment, every shared
// challenge frozen, and STUCK closed, because the extend-the-deadline revive
// re-checks all-solved and refuses while it still holds.
//
// The schedule model is worth stating because the alternative looks cheaper and is
// not. `duration_minutes` is INTEGER NOT NULL, so an open-ended Program has to put
// SOME number there; the only value that both satisfies the schema and looks
// deliberate is the 525600 cap — and that value is not inert, it closes the
// Program on its first anniversary. Deriving the duration from a real deadline is
// the only model that leaves no column holding a value nobody chose.
const fs = require("fs");
const path = require("path");
const { test, expect } = require("./isolated-test");
const { registerPost } = require("./helpers");
const { freshCtx, getSuperadminPass, gradingHashFor, TEST_DB_PATH, PARTICIPANT_PASS, codeLogin } = require("./helpers");

const H = (csrf) => ({ "x-csrf-token": csrf, "content-type": "application/json" });
const TAG = `ps${Date.now().toString(36)}`;
const ROOT = path.join(__dirname, "..");

async function sa() {
  const { api, csrf: c0 } = await freshCtx();
  const r = await api.post("/api/login", { headers: H(c0), data: { email: "superadmin", password: getSuperadminPass() } });
  expect(r.ok(), `superadmin login: ${r.status()}`).toBeTruthy();
  return { api, csrf: (await (await api.get("/api/csrf-token")).json()).csrfToken };
}

const dbGet = (sql, ...a) => {
  const Database = require("better-sqlite3");
  const db = new Database(TEST_DB_PATH, { readonly: true });
  try { return db.prepare(sql).get(...a); } finally { db.close(); }
};

test.describe("v8.1.0 — the deadline schedule", () => {
  test("a Program takes a deadline and DERIVES its duration; a Competition refuses one", async () => {
    const { api, csrf } = await sa();
    try {
      const start = new Date(Date.now() + 3600e3);
      const deadline = new Date(start.getTime() + 90 * 86400e3 + 30_000);   // +30s → ceil proves itself

      const ok = await api.post("/api/admin/competitions", {
        headers: H(csrf),
        data: { name: `${TAG} Prog`, event_kind: "program", start_time: start.toISOString(), deadline_at: deadline.toISOString(), timezone: "UTC" },
      });
      expect(ok.ok(), `create program: ${ok.status()} ${await ok.text()}`).toBeTruthy();
      const comp = (await ok.json()).competition;
      // CEIL, not round: the derived end must never be EARLIER than the stated
      // deadline, and never more than 60 s later.
      const expected = Math.ceil((deadline.getTime() - start.getTime()) / 60000);
      expect(comp.duration_minutes, "the duration is derived by ceil").toBe(expected);
      expect(new Date(comp.deadline_at).toISOString(), "the deadline is stored as given").toBe(deadline.toISOString());
      // It exceeds the 365-day REQUEST cap, which is the point: it was not
      // requested. 90 days is inside it, so use a real long one to prove it.
      const long = await api.post("/api/admin/competitions", {
        headers: H(csrf),
        data: { name: `${TAG} Prog10y`, event_kind: "program", start_time: start.toISOString(),
          deadline_at: new Date(start.getTime() + 3652 * 86400e3).toISOString(), timezone: "UTC" },
      });
      expect(long.ok(), `ten-year program: ${long.status()} ${await long.text()}`).toBeTruthy();
      expect((await long.json()).competition.duration_minutes,
        "a derived duration may far exceed the 525600 request cap").toBeGreaterThan(525600);

      // A window-shaped kind REFUSES a deadline — accept-and-ignore would be a
      // control that appears to work, and the column would then duplicate
      // start + duration with nothing keeping the two in step.
      const bad = await api.post("/api/admin/competitions", {
        headers: H(csrf),
        data: { name: `${TAG} CompDl`, start_time: start.toISOString(), duration_minutes: 60, deadline_at: deadline.toISOString(), timezone: "UTC" },
      });
      expect(bad.status()).toBe(400);
      expect((await bad.json()).code).toBe("deadline_not_accepted");
    } finally { await api.dispose(); }
  });

  test("every refusal on the deadline path is NAMED", async () => {
    const { api, csrf } = await sa();
    const start = new Date(Date.now() + 3600e3);
    const mk = (extra) => api.post("/api/admin/competitions", {
      headers: H(csrf),
      data: { name: `${TAG} R${Math.random().toString(36).slice(2, 8)}`, event_kind: "program", start_time: start.toISOString(), timezone: "UTC", ...extra },
    });
    try {
      expect((await (await mk({})).json()).code, "a Program with no deadline").toBe("deadline_required");
      expect((await (await mk({ deadline_at: new Date(start.getTime() - 1000).toISOString() })).json()).code,
        "a deadline before the start").toBe("deadline_before_start");
      expect((await (await mk({ deadline_at: new Date(start.getTime() + 21 * 365 * 86400e3).toISOString() })).json()).code,
        "21 years out — the API BOUNDARY rule, not the typo defence").toBe("deadline_too_far");
      // A submitted duration that DISAGREES is refused; one that echoes the derived
      // value is not a change, exactly as an echoed event_kind is not — a client
      // that round-trips the whole row must keep working.
      const dl = new Date(start.getTime() + 120 * 60000).toISOString();
      expect((await (await mk({ deadline_at: dl, duration_minutes: 99 })).json()).code,
        "a duration that disagrees with the deadline").toBe("duration_not_accepted");
      const echo = await mk({ deadline_at: dl, duration_minutes: 120 });
      expect(echo.ok(), `echoing the derived duration is not a change: ${await echo.text()}`).toBeTruthy();
    } finally { await api.dispose(); }
  });

  test("the PUT derives from the STORED start, and extending moves the duration with it", async () => {
    const { api, csrf } = await sa();
    try {
      const start = new Date(Date.now() - 3600e3);         // already open
      const dl1 = new Date(start.getTime() + 30 * 86400e3);
      const cr = await api.post("/api/admin/competitions", {
        headers: H(csrf),
        data: { name: `${TAG} Extend`, event_kind: "program", start_time: start.toISOString(), deadline_at: dl1.toISOString(), timezone: "UTC" },
      });
      expect(cr.ok(), `create: ${await cr.text()}`).toBeTruthy();
      const comp = (await cr.json()).competition;

      const dl2 = new Date(start.getTime() + 60 * 86400e3);
      const put = await api.put(`/api/admin/competitions/${comp.id}`, {
        headers: H(csrf), data: { deadline_at: dl2.toISOString(), expectedUpdatedAt: comp.updated_at },
      });
      expect(put.ok(), `extend: ${put.status()} ${await put.text()}`).toBeTruthy();
      const after = (await put.json()).competition;
      // Derived from the STORED start. start_time is immutable once started, so
      // deriving from a submitted one would silently desync the pair on the path
      // an admin uses most.
      expect(after.duration_minutes).toBe(Math.ceil((dl2.getTime() - start.getTime()) / 60000));
      expect(new Date(after.deadline_at).getTime()).toBe(dl2.getTime());

      // And a duration submitted to a deadline-shaped event is refused by name.
      const bad = await api.put(`/api/admin/competitions/${comp.id}`, {
        headers: H(csrf), data: { duration_minutes: 42, expectedUpdatedAt: after.updated_at },
      });
      expect(bad.status()).toBe(400);
      expect((await bad.json()).code).toBe("duration_not_accepted");
    } finally { await api.dispose(); }
  });

  test("A PROGRAM DOES NOT CLOSE ITSELF when its only enrollee finishes — with a Competition control", async () => {
    // The column existed and nothing read it. Without the gate a Program built for
    // rolling enrolment closes on its first finisher, freezing every challenge it
    // shares and refusing to revive while all-solved still holds.
    const { api, csrf } = await sa();
    let papi;
    try {
      const start = new Date(Date.now() - 3600e3);
      const mkComp = async (kind, label) => {
        const body = kind === "program"
          ? { deadline_at: new Date(start.getTime() + 365 * 86400e3).toISOString() }
          : { duration_minutes: 600 };
        const r = await api.post("/api/admin/competitions", {
          headers: H(csrf),
          data: { name: `${TAG} ${label}`, event_kind: kind, start_time: start.toISOString(), timezone: "UTC", ...body },
        });
        expect(r.ok(), `create ${label}: ${await r.text()}`).toBeTruthy();
        return (await r.json()).competition.id;
      };
      const prog = await mkComp("program", "AutoProg");
      const comp = await mkComp("tournament", "AutoComp");

      expect(dbGet("SELECT auto_end_on_all_solved a FROM competitions WHERE id=?", prog).a,
        "a Program is created with auto-end OFF, from the kind's policy").toBe(0);
      expect(dbGet("SELECT auto_end_on_all_solved a FROM competitions WHERE id=?", comp).a,
        "a Competition keeps auto-end ON — the positive control").toBe(1);

      // One challenge each, one participant enrolled in both.
      const mkTask = async (title, compId) => {
        const t = await api.post("/api/admin/tasks", {
          headers: H(csrf),
          data: { title, description: "d", difficulty: "easy", answer_type: "text", correct_answer: "yes", status: "published" },
        });
        expect(t.ok(), `task ${title}: ${await t.text()}`).toBeTruthy();
        const id = (await t.json()).task?.id || (await t.json()).id;
        const a = await api.post(`/api/admin/tasks/${id}/competitions`, { headers: H(csrf), data: { competitionIds: [compId] } });
        expect(a.ok(), `assign task: ${await a.text()}`).toBeTruthy();
        return id;
      };
      const tProg = await mkTask(`${TAG} TP`, prog);
      const tComp = await mkTask(`${TAG} TC`, comp);

      const email = `${TAG}-solo@company.example`;
      const reg = await registerPost(api, "/api/register", {
        headers: H(csrf),
        data: {
          firstName: "Solo", lastName: "Finisher", nickname: `${TAG}_solo`, email,
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
        headers: H(csrf), data: { userIds: [String(u.id)], competitionIds: [prog, comp] },
      });
      expect(asg.ok(), `assign: ${await asg.text()}`).toBeTruthy();
      expect((await asg.json()).assigned, "the sole enrollee was enrolled").toBeGreaterThan(0);

      const pc = await freshCtx();
      papi = pc.api;
      const li = await codeLogin(papi, email, H(pc.csrf));
      expect(li.ok(), `participant login: ${await li.text()}`).toBeTruthy();
      const pcsrf = (await (await papi.get("/api/csrf-token")).json()).csrfToken;

      const solve = async (compId, taskId) => {
        const sel = await papi.post("/api/select-competition", { headers: H(pcsrf), data: { competitionId: compId } });
        expect(sel.ok(), `select: ${await sel.text()}`).toBeTruthy();
        const sub = await papi.post(`/api/tasks/${taskId}/submit`, {
          headers: H(pcsrf), data: { answer: "yes", gradingHash: await gradingHashFor(papi, taskId) },
        });
        expect(sub.ok(), `submit: ${sub.status()} ${await sub.text()}`).toBeTruthy();
        expect((await sub.json()).correct, "the answer was accepted").toBe(true);
      };

      // The CONTROL first: a Competition in the identical shape DOES auto-end.
      // Without it, "the Program stayed open" is equally satisfied by a build
      // where auto-end never fires for anyone.
      await solve(comp, tComp);
      await expect.poll(() => dbGet("SELECT ended_at e FROM competitions WHERE id=?", comp).e,
        { timeout: 8000, intervals: [100, 200, 400, 800] }).toBeTruthy();

      await solve(prog, tProg);
      // Give the auto-end scan the same window it had to close the control.
      await new Promise(r => setTimeout(r, 1500));
      expect(dbGet("SELECT ended_at e FROM competitions WHERE id=?", prog).e,
        "the Program is STILL OPEN after its sole enrollee solved everything").toBeNull();
    } finally {
      await api.dispose();
      if (papi) await papi.dispose();
    }
  });
});

test.describe("v8.1.0 — the two derived helpers", () => {
  test("eventDeadline prefers a closure, then the stated deadline, then the window", () => {
    const c = require("../lib/competitions");
    const start = new Date(Date.now() - 86400e3).toISOString();
    const dl = new Date(Date.now() + 10 * 86400e3);
    expect(c.eventDeadline({ id: "x", event_kind: "program", start_time: start, duration_minutes: 100, deadline_at: dl.toISOString(), ended_at: null }, []).getTime())
      .toBe(dl.getTime());
    // A window-shaped kind has a deadline too — derived, at zero storage and zero
    // drift, which is why deadline_at is not backfilled onto every Competition.
    const win = c.eventDeadline({ id: "x", event_kind: "tournament", start_time: start, duration_minutes: 60, deadline_at: null, ended_at: null }, []);
    expect(win.getTime()).toBe(new Date(start).getTime() + 60 * 60000);
  });

  test("a CLOSED Program is never open-ended — the defect a deadline_at-keyed predicate would ship", () => {
    // Keyed on the column alone, a closed Program would print "No fixed deadline"
    // while refusing certificates and freezing its challenges.
    const c = require("../lib/competitions");
    const start = new Date(Date.now() - 86400e3).toISOString();
    const far = new Date(Date.now() + 3652 * 86400e3).toISOString();
    const open = { id: "x", event_kind: "program", start_time: start, duration_minutes: 5_260_320, deadline_at: far, ended_at: null };
    expect(c.isOpenEnded(open, []), "a decade out reads open-ended").toBe(true);
    expect(c.isOpenEnded({ ...open, ended_at: new Date().toISOString() }, []),
      "the same Program, closed, does NOT").toBe(false);
    // And it decays truthfully, because it is measured from NOW rather than from
    // the immutable start_time.
    expect(c.isOpenEnded({ ...open, deadline_at: new Date(Date.now() + 4 * 365 * 86400e3).toISOString() }, []),
      "four years out prints its date instead").toBe(false);
    expect(c.isOpenEnded({ ...open, event_kind: "tournament", deadline_at: null }, []),
      "a window-shaped kind is never open-ended").toBe(false);
  });

  test("the open-ended threshold is MIRRORED, not re-invented", () => {
    // A divergence cannot corrupt data — it makes one surface say "No fixed
    // deadline" while another prints a date — but that is a visible contradiction
    // on an admin's screen, and public/js is a browser-only ESM graph so the copy
    // is irreducible. Same family as DIFF_PTS and DRY_RUN_TAG.
    const server = require("../lib/competitions").OPEN_ENDED_THRESHOLD_DAYS;
    const client = fs.readFileSync(path.join(ROOT, "public/js/features/competitions-admin.js"), "utf8");
    const m = client.match(/OPEN_ENDED_THRESHOLD_DAYS\s*=\s*(\d+)/);
    expect(m, "the client declares the threshold").toBeTruthy();
    expect(Number(m[1]), "client and server agree on the open-ended line").toBe(server);
    // An INTEGER DAY COUNT on both sides, so the mirror can be exact — a
    // float-derived millisecond value could not be compared this way.
    expect(Number.isInteger(server)).toBe(true);
  });

  test("v8.1.0 — the admin LIST carries deadline_at, so the edit form can show it", async () => {
    // Found by the PR 22 fixture, not by a symptom. `openCompetitionEditor`
    // populates the deadline date/time inputs from `comp.deadline_at`, and that
    // object comes from `S.adminCompetitionsData` — i.e. from THIS payload. The
    // list SELECT names its columns and never included the one PR 16 added, so
    // opening ANY Program for edit showed an empty deadline, and a save that did
    // not retype it would have moved the schedule.
    const { api, csrf } = await sa();
    try {
      const deadline = new Date(Date.now() + 120 * 86400e3).toISOString();
      const cr = await api.post("/api/admin/competitions", {
        headers: H(csrf),
        data: {
          name: `${TAG} ListDeadline`, event_kind: "program",
          start_time: new Date(Date.now() - 3600e3).toISOString(),
          deadline_at: deadline, timezone: "UTC",
        },
      });
      expect(cr.ok(), await cr.text()).toBeTruthy();
      const id = (await cr.json()).competition.id;

      const list = await (await api.get("/api/admin/competitions")).json();
      const row = list.find(c => c.id === id);
      expect(row, "the Program is in the admin list").toBeTruthy();
      expect(row.deadline_at, "the list carries the deadline the edit form renders from").toBeTruthy();
      expect(new Date(row.deadline_at).getTime()).toBe(new Date(deadline).getTime());
      // The two siblings added in the same block, for the same reason: a client
      // that renders a column needs the column.
      expect(row, "the auto-end opt-out is on the list too").toHaveProperty("auto_end_on_all_solved");
      expect(row, "and the event-level attempt cap").toHaveProperty("attempt_cap");
    } finally { await api.dispose(); }
  });
});
