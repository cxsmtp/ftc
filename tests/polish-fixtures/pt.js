"use strict";
// UI-polish capture fixtures, group "pt": the sign-in, participant and
// appearance screens (tests/_ui-polish.spec.js runs them as `fixture <name>`).
//
// Every fixture builds what its screen needs through the doors the app itself
// uses (the email-first registration, the admin event, challenge and session
// routes, Users & roles, the desk code), with names unique within the run, and
// returns the values its route reads as {{key.field}}. None touches the seeded
// alice/bob/carol, the seeded events or a global setting. Each one's cleanup
// removes what it made (the accounts, then the events, then the challenges), so
// the shared capture server stays close to the seed for the entries after it.
//
// This module requires nothing that reaches the database: everything goes
// through HTTP (`helpers` is tests/helpers.js, handed in by the harness).

const H = (c) => ({ "x-csrf-token": c, "content-type": "application/json" });
const MIN = 60_000;
const DOMAIN = "northwind.example";        // a work domain: no free-mail rule applies
// Names and addresses are unique within a run and the SAME in every run: each
// capture run starts its own fresh server (tests/isolated-test.js), so a counter
// cannot collide, and a before/after pair then shows the same text instead of
// two timestamps. (A worker that restarts after a failure restarts the server too.)
let seq = 0;
const uniq = () => `${++seq}`;
const address = (first, last) => `${first}.${last}.${uniq()}@${DOMAIN}`.toLowerCase();

async function body(res, what) {
  const text = await res.text();
  if (!res.ok()) throw new Error(`${what}: ${res.status()} ${text.slice(0, 300)}`);
  try { return JSON.parse(text); } catch (_) { return {}; }
}

/** A superadmin API session plus the ledger of what this fixture made. */
async function start(helpers) {
  const { api, csrf } = await helpers.apiLogin("superadmin");
  return { helpers, api, h: H(csrf), made: { users: [], comps: [], tasks: [] } };
}

/**
 * Remove what the fixture made, on a FRESH superadmin session (the route may
 * have signed somebody else in since), in the order the server accepts it:
 * accounts first (`force`, so one still in a live event goes too), then events
 * (End Now first, as a live event in use cannot be deleted), then challenges
 * (no longer frozen once their ended event is gone). Best effort per item; the
 * misses are reported together so the harness's warning names all of them.
 */
function cleanupFor(fx) {
  return async () => {
    await fx.api.dispose().catch(() => null);
    const { users, comps, tasks } = fx.made;
    if (!users.length && !comps.length && !tasks.length) return;
    const { api, csrf } = await fx.helpers.apiLogin("superadmin");
    const h = H(csrf);
    const misses = [];
    const del = async (url, what) => {
      const r = await api.delete(url, { headers: h }).catch((e) => ({ ok: () => false, status: () => 0, text: async () => e.message }));
      if (!r.ok() && r.status() !== 404) misses.push(`${what}: ${r.status()} ${(await r.text()).slice(0, 120)}`);
    };
    try {
      for (const id of users) await del(`/api/admin/participants/${id}?force=1`, `account ${id}`);
      for (const id of comps) {
        await api.post(`/api/admin/competitions/${id}/end-now`, { headers: h }).catch(() => null);
        await del(`/api/admin/competitions/${id}`, `event ${id}`);
      }
      for (const id of tasks) await del(`/api/admin/tasks/${id}`, `challenge ${id}`);
    } finally { await api.dispose().catch(() => null); }
    if (misses.length) throw new Error(`could not remove: ${misses.join("; ")}`);
  };
}

/** An event made through POST /api/admin/competitions, live by default. */
async function makeEvent(fx, { kind = "tournament", label = "Event", startMs = -30 * MIN, minutes = 240, extra = {} } = {}) {
  const name = `${label} ${uniq()}`;
  const d = await body(await fx.api.post("/api/admin/competitions", { headers: fx.h, data: {
    name, event_kind: kind, timezone: "UTC",
    start_time: new Date(Date.now() + startMs).toISOString(), duration_minutes: minutes,
    // The event holds only the challenges the fixture gives it.
    add_qualifying: false,
    ...extra,
  } }), `create ${kind} event`);
  fx.made.comps.push(d.competition.id);
  return d.competition;
}

/** A published challenge, assigned to `compId`. */
async function makeChallenge(fx, compId, data) {
  const d = await body(await fx.api.post("/api/admin/tasks", { headers: fx.h, data: {
    description: "<p>Read the scenario, then answer.</p>", difficulty: "easy", status: "published", ...data,
  } }), `create challenge "${data.title}"`);
  fx.made.tasks.push(d.id);
  await body(await fx.api.post(`/api/admin/tasks/${d.id}/competitions`, { headers: fx.h, data: { competitionIds: [compId] } }), "assign challenge");
  return d.id;
}

/** A text challenge with a known answer. */
async function textChallenge(fx, compId, title, answer, difficulty = "easy") {
  return makeChallenge(fx, compId, { title, difficulty, answer_type: "text", correct_answer: answer });
}

/**
 * A participant through the real email-first doors (tests/helpers.js
 * registerPost: proof code, redeem, the short form), complete profile.
 * `keepState` leaves the real verified, approved account; without it the
 * registration is rewound to registerPost's fixture state (unverified, never
 * signed in, approved only when a join link made it; no sign-up creates it).
 */
async function makeParticipant(fx, { first = "Avery", last = "Quinn", keepState = true, joinToken } = {}) {
  const email = address(first, last);
  // The handle is given, not suggested: the server's suggestion carries a random
  // suffix, and boards and certificates print it.
  const nickname = email.split("@")[0].replace(/[^a-z0-9]+/g, "_");
  const r = await fx.helpers.registerPost(fx.api, "/api/register", { headers: fx.h, keepState, data: {
    firstName: first, lastName: last, nickname, email, company: "Northwind Labs", title: "Security Engineer",
    country: "US", timezone: "America/New_York", jobFunction: "Software Developer / Engineer", city: "Boston",
    ...(joinToken ? { joinToken } : {}),
  } });
  const d = await body(r, `register ${email}`);
  if (!d.id) throw new Error(`register ${email} answered no account id: ${JSON.stringify(d).slice(0, 200)}`);
  fx.made.users.push(d.id);
  return { id: d.id, email };
}

/** Enrol participants; the endpoint skips ineligible users with a 200, so the count is asserted. */
async function enrol(fx, compId, userIds) {
  const d = await body(await fx.api.post("/api/admin/competitions/assign", { headers: fx.h, data: { userIds, competitionIds: [compId] } }), "assign");
  if (d.assigned !== userIds.length) throw new Error(`assign attached ${d.assigned} of ${userIds.length}: ${JSON.stringify(d).slice(0, 200)}`);
}

/** The participant's own API session (an emailed code, as the SPA signs in). */
async function asParticipant(fx, email) {
  const { api, csrf } = await fx.helpers.apiLogin(email);
  return { api, h: H(csrf) };
}

/** Sign THIS page's browser context in with a code the caller already holds (a desk code). */
async function redeemOnPage(page, email, code) {
  const t = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
  const r = await page.request.post("/api/auth/code/redeem", { headers: H(t), data: { email, code } });
  const d = await body(r, `redeem ${email}`);
  if (!d.ok) throw new Error(`redeem ${email} refused: ${JSON.stringify(d).slice(0, 200)}`);
}

/** A participant who answered one challenge of a tournament, which has then ended. */
async function endedRun(fx, { answer }) {
  const comp = await makeEvent(fx, { label: "Harbour Night CTF" });
  const t1 = await textChallenge(fx, comp.id, "Find the leaked key", "k3y-found");
  // A second challenge keeps one solve from ending the event on its own
  // (all-solved auto-end); the fixture ends it explicitly instead.
  await textChallenge(fx, comp.id, "Trace the redirect chain", "chain-ok", "medium");
  const p = await makeParticipant(fx);
  await enrol(fx, comp.id, [p.id]);
  const me = await asParticipant(fx, p.email);
  try {
    await body(await me.api.post("/api/select-competition", { headers: me.h, data: { competitionId: comp.id } }), "select-competition");
    if (answer) {
      const t = await body(await me.api.get(`/api/tasks/${t1}`), "open challenge");
      const s = await body(await me.api.post(`/api/tasks/${t1}/submit`, { headers: me.h, data: { answer: "k3y-found", gradingHash: t.grading_hash } }), "submit");
      if (!s.correct) throw new Error(`the fixture's answer was not graded correct: ${JSON.stringify(s).slice(0, 200)}`);
    }
    await body(await fx.api.post(`/api/admin/competitions/${comp.id}/end-now`, { headers: fx.h }), "end-now");
    return { comp, p, me };
  } catch (e) { await me.api.dispose().catch(() => null); throw e; }
}

module.exports = {
  /** A work address nobody holds: Continue mails it an address proof (the sign-up door). */
  ptNewAddress: async () => ({ email: address("Riley", "Chen") }),

  /** A signed-up participant with no event: signs in with an emailed code. */
  ptAccount: async ({ helpers }) => {
    const fx = await start(helpers);
    try {
      const p = await makeParticipant(fx);
      return { email: p.email, cleanup: cleanupFor(fx) };
    } catch (e) { await cleanupFor(fx)().catch(() => null); throw e; }
  },

  /** A participant enrolled in a live tournament with two challenges (one easy, one medium). */
  ptMember: async ({ helpers }) => {
    const fx = await start(helpers);
    try {
      const comp = await makeEvent(fx, { label: "Harbour Night CTF" });
      const taskId = await textChallenge(fx, comp.id, "Find the leaked key", "k3y-found");
      await textChallenge(fx, comp.id, "Trace the redirect chain", "chain-ok", "medium");
      const p = await makeParticipant(fx);
      await enrol(fx, comp.id, [p.id]);
      return { email: p.email, name: comp.name, compId: comp.id, taskId, answer: "k3y-found", cleanup: cleanupFor(fx) };
    } catch (e) { await cleanupFor(fx)().catch(() => null); throw e; }
  },

  /** A participant whose only event is an upcoming tournament: signing in lands them on its pending page. */
  ptUpcoming: async ({ helpers }) => {
    const fx = await start(helpers);
    try {
      const comp = await makeEvent(fx, { label: "Spring Qualifier", startMs: 2 * 60 * MIN, minutes: 120 });
      await textChallenge(fx, comp.id, "Find the leaked key", "k3y-found");
      const p = await makeParticipant(fx);
      await enrol(fx, comp.id, [p.id]);
      return { email: p.email, name: comp.name, cleanup: cleanupFor(fx) };
    } catch (e) { await cleanupFor(fx)().catch(() => null); throw e; }
  },

  /**
   * An admin made in Users & roles: an unscoped role signs in with a password by
   * default and none is set, so its sign-in answers `password_required` and the
   * SPA asks it to set one (or keep using codes).
   */
  ptPasswordAdmin: async ({ helpers }) => {
    const fx = await start(helpers);
    try {
      const email = address("Morgan", "Reyes");
      const d = await body(await fx.api.post("/api/admin/users", { headers: fx.h, data: { email, role: "admin", first_name: "Morgan", last_name: "Reyes" } }), "add admin user");
      fx.made.users.push(d.id);
      return { email, cleanup: cleanupFor(fx) };
    } catch (e) { await cleanupFor(fx)().catch(() => null); throw e; }
  },

  /** A live Booth Event whose join link is on: its token, for /join/<token>. */
  ptJoinEvent: async ({ helpers }) => {
    const fx = await start(helpers);
    try {
      const comp = await makeEvent(fx, { kind: "booth", label: "Booth Day Lisbon", startMs: -60 * MIN, minutes: 600, extra: { self_enroll_enabled: true } });
      const d = await body(await fx.api.get(`/api/admin/competitions/${comp.id}/self-enroll`), "reveal join link");
      if (!d.token) throw new Error("the join-link reveal carried no token");
      return { token: d.token, name: comp.name, cleanup: cleanupFor(fx) };
    } catch (e) { await cleanupFor(fx)().catch(() => null); throw e; }
  },

  /**
   * A participant SIGNED IN ON THIS PAGE while unverified, inside the 48-hour
   * grace: joined through a Booth Event's join link (approved by the
   * join), then let in with a desk code, which never verifies (routes/auth.js
   * re-stamps the grace instead). Email-first sign-up always proves the address,
   * so the account is put back to unverified by registerPost's own default (the
   * test-only POST /api/test/registration-legacy-state): no ordinary door leaves
   * an approved account unverified any more.
   */
  ptGrace: async ({ page, helpers }) => {
    const fx = await start(helpers);
    try {
      const comp = await makeEvent(fx, { kind: "booth", label: "Booth Day Lisbon", startMs: -60 * MIN, minutes: 600, extra: { self_enroll_enabled: true } });
      const link = await body(await fx.api.get(`/api/admin/competitions/${comp.id}/self-enroll`), "reveal join link");
      const p = await makeParticipant(fx, { keepState: false, joinToken: link.token });
      const desk = await body(await fx.api.post(`/api/admin/participants/${p.id}/login-code/reveal`, { headers: fx.h }), "desk code");
      await redeemOnPage(page, p.email, desk.code);
      return { email: p.email, cleanup: cleanupFor(fx) };
    } catch (e) { await cleanupFor(fx)().catch(() => null); throw e; }
  },

  /**
   * A walk-up SIGNED IN ON THIS PAGE with an incomplete profile: created at the
   * desk (name and address only) for a live Booth Event and let in with the desk
   * code, so the profile-completion gate asks for company, title, country and
   * time zone.
   */
  ptWalkup: async ({ page, helpers }) => {
    const fx = await start(helpers);
    try {
      const comp = await makeEvent(fx, { kind: "booth", label: "Booth Day Lisbon", startMs: -60 * MIN, minutes: 600 });
      const email = address("Jamie", "Okafor");
      const d = await body(await fx.api.post("/api/admin/participants/desk-invite", { headers: fx.h, data: { email, firstName: "Jamie", lastName: "Okafor", competitionId: comp.id } }), "desk invite");
      fx.made.users.push(d.id);
      await redeemOnPage(page, email, d.code);
      return { email, cleanup: cleanupFor(fx) };
    } catch (e) { await cleanupFor(fx)().catch(() => null); throw e; }
  },

  /** A participant whose active event has just ended and who has not seen the ended notice. */
  ptEnded: async ({ helpers }) => {
    const fx = await start(helpers);
    try {
      const { p, me } = await endedRun(fx, { answer: false });
      await me.api.dispose().catch(() => null);
      return { email: p.email, cleanup: cleanupFor(fx) };
    } catch (e) { await cleanupFor(fx)().catch(() => null); throw e; }
  },

  /**
   * A participant who solved a challenge in a tournament that has ended, with
   * the ended notice already dismissed: the Challenges page offers the
   * certificate (#cert-cta) and the leaderboard its certificate card.
   */
  ptCertificate: async ({ helpers }) => {
    const fx = await start(helpers);
    try {
      const { comp, p, me } = await endedRun(fx, { answer: true });
      try {
        await body(await me.api.post("/api/dismiss-ended", { headers: me.h }), "dismiss-ended");
      } finally { await me.api.dispose().catch(() => null); }
      return { email: p.email, compId: comp.id, cleanup: cleanupFor(fx) };
    } catch (e) { await cleanupFor(fx)().catch(() => null); throw e; }
  },

  /** A participant in a live Booth Event holding one multiple-choice challenge. */
  ptBooth: async ({ helpers }) => {
    const fx = await start(helpers);
    try {
      const comp = await makeEvent(fx, { kind: "booth", label: "Booth Day Lisbon", startMs: -60 * MIN, minutes: 600 });
      const taskId = await makeChallenge(fx, comp.id, {
        title: "Which query is safe from SQL injection?", difficulty: "medium", answer_type: "choice",
        description: "<p>A login form builds its database query from the username a visitor types. Which approach stops an attacker from changing what the query does?</p>",
        choices: [
          { text: "Concatenating the username into the SQL string" },
          { text: "Escaping quotes with a regular expression" },
          { text: "A parameterised query with a bound value", correct: true },
          { text: "Hiding the error message from the user" },
        ],
      });
      const p = await makeParticipant(fx);
      await enrol(fx, comp.id, [p.id]);
      return { email: p.email, taskId, cleanup: cleanupFor(fx) };
    } catch (e) { await cleanupFor(fx)().catch(() => null); throw e; }
  },

  /** A participant in a tournament with two sessions (one live now, one starting in four hours) and no session chosen. */
  ptSessions: async ({ helpers }) => {
    const fx = await start(helpers);
    try {
      const comp = await makeEvent(fx, { label: "Regional Finals", startMs: -30 * MIN, minutes: 600 });
      for (const [name, startMs] of [["Morning session", -15 * MIN], ["Afternoon session", 4 * 60 * MIN]]) {
        await body(await fx.api.post(`/api/admin/competitions/${comp.id}/timeslots`, { headers: fx.h, data: {
          name, start_time: new Date(Date.now() + startMs).toISOString(), duration_minutes: 120,
        } }), `add session "${name}"`);
      }
      await textChallenge(fx, comp.id, "Find the leaked key", "k3y-found");
      const p = await makeParticipant(fx);
      await enrol(fx, comp.id, [p.id]);
      return { email: p.email, name: comp.name, cleanup: cleanupFor(fx) };
    } catch (e) { await cleanupFor(fx)().catch(() => null); throw e; }
  },
};
