"use strict";
// @ts-check
//
// Polish-capture fixtures for the "ws" group of .claude/screens.json: the event
// workspace (its Overview in each state, the ⋯ menu's panels, the join popover
// and full-screen QR, Certificates, Team & reports), the New event page and its
// templates, an event admin's quick spin and the Events list's pager.
//
// Every fixture builds its OWN events, people, challenges and templates through
// the doors the UI uses, named with a fixed-width tag so no name can contain
// another (the Events search is a substring match), and its `cleanup` removes
// them again: the seeded alice, bob, carol and the three "Test …" events are
// only ever read. The one global setting a fixture changes (the event-team
// allowed domains) is put back to its default, none.
//
// SESSIONS. One session per principal: a second superadmin sign-in ends the
// first. So a fixture that runs AFTER the route's `apiLogin superadmin` works on
// the PAGE's own session (`page.request`), and it must run BEFORE `goto /`:
// every /api/csrf-token call replaces the session's token, and taking it from
// under a booted SPA would make the SPA's next write end the session. Cleanup
// leaves the page first (about:blank), then takes a fresh token. A route whose
// page signs in as somebody else (the event admin's quick spin) gets a
// superadmin session of the fixture's own.

const DOMAIN = "northwind-ws.com";

let _seq = 0;
// Five time characters plus a two-character counter: fixed width, so two tags
// are never substrings of each other.
function tag() {
  _seq = (_seq + 1) % 1296;
  return Date.now().toString(36).slice(-5) + _seq.toString(36).padStart(2, "0");
}

/** A JSON client over one request context, holding that session's CSRF token. */
function client(api) {
  let token = "";
  const c = {
    api,
    async refresh() {
      const r = await api.get("/api/csrf-token");
      if (!r.ok()) throw new Error(`GET /api/csrf-token: ${r.status()} ${await r.text()}`);
      token = (await r.json()).csrfToken;
    },
    headers() { return { "x-csrf-token": token, "content-type": "application/json" }; },
    async call(method, url, data) {
      if (method !== "GET" && !token) await c.refresh();
      const r = await api.fetch(url, { method, headers: c.headers(), ...(data === undefined ? {} : { data }) });
      let body = null;
      try { body = await r.json(); } catch (_) { body = null; }
      return { ok: r.ok(), status: r.status(), body };
    },
    async must(method, url, data) {
      const r = await c.call(method, url, data);
      if (!r.ok) throw new Error(`${method} ${url}: ${r.status} ${JSON.stringify(r.body)}`);
      return r.body;
    },
  };
  return c;
}

// The superadmin's API on the PAGE's own session (see SESSIONS above).
async function pageAdmin(page) {
  const adm = client(page.request);
  const me = await adm.call("GET", "/api/admin/me");
  if (!me.ok || !me.body || me.body.isSuperAdmin !== true) {
    throw new Error("this fixture works on the page's superadmin session: put `apiLogin superadmin` before it in the route, and `goto /` after it");
  }
  await adm.refresh();
  return adm;
}

// A superadmin session of the fixture's own, for a route whose page signs in as
// somebody else.
async function ownAdmin(helpers) {
  const { api } = await helpers.apiLogin("superadmin");
  const adm = client(api);
  await adm.refresh();
  return adm;
}

const iso = (msFromNow) => new Date(Date.now() + msFromNow).toISOString();
const MIN = 60_000, HOUR = 3_600_000;

async function makeEvent(adm, fields) {
  return (await adm.must("POST", "/api/admin/competitions", fields)).competition;
}

async function makeTask(adm, compId, { title, difficulty = "easy", answer, hidden = false }) {
  const t = await adm.must("POST", "/api/admin/tasks", {
    title, difficulty, answer_type: "text", correct_answer: answer, status: "published",
    description: `<p>${title}: find the flaw and enter the answer.</p>`,
    explanation: "<p>The fix validates the input before it reaches the query.</p>",
    hint: "Look at where the input is used.",
  });
  await adm.must("POST", `/api/admin/tasks/${t.id}/competitions`, { competitionIds: [compId] });
  // Hidden = published but not visible to participants (the Overview flags it).
  if (hidden) await adm.must("PATCH", `/api/admin/tasks/${t.id}/visibility`, {});
  return t.id;
}

const PEOPLE = [
  { first: "Priya", last: "Natarajan", company: "Northwind Traders", title: "Staff Engineer", avatar: "🦊" },
  { first: "Marco", last: "Bianchi", company: "Contoso", title: "AppSec Lead", avatar: "🐼" },
  { first: "Aiko", last: "Tanaka", company: "Fabrikam", title: "Developer", avatar: "🦉" },
  { first: "Tomas", last: "Herrera", company: "Tailspin Toys", title: "Engineering Manager", avatar: "🐙" },
  { first: "Grace", last: "Okafor", company: "Litware", title: "Security Architect", avatar: "🦁" },
  { first: "Liam", last: "Murphy", company: "Northwind Traders", title: "Solutions Engineer", avatar: "🦅" },
];

/**
 * A participant through the real email-first doors (tests/helpers.js
 * registerPost, `keepState: true`): a verified, approved account. Returns
 * { id, email }.
 */
async function makePerson(adm, helpers, BASE, p, t) {
  const email = `${p.first.toLowerCase()}.${t}@${DOMAIN}`;
  const r = await helpers.registerPost(adm.api, BASE + "/api/register", {
    headers: adm.headers(),
    data: {
      firstName: p.first, lastName: p.last, email,
      company: p.company, title: p.title, avatar: p.avatar, country: "US", timezone: "America/New_York",
      jobFunction: "Software Developer / Engineer", city: "Boston",
    },
    keepState: true,
  });
  const body = await r.json().catch(() => null);
  if (!r.ok() || !body || !body.id) throw new Error(`register ${email}: ${r.status()} ${JSON.stringify(body)}`);
  return { id: body.id, email };
}

async function enrol(adm, compId, ids) {
  const d = await adm.must("POST", "/api/admin/competitions/assign", { userIds: ids, competitionIds: [compId] });
  if (d.assigned !== ids.length) throw new Error(`assign: ${d.assigned} of ${ids.length} enrolled ${JSON.stringify(d)}`);
}

/**
 * Sign in as a participant (its own request context, so no other session is
 * touched), enter the event and answer: each move is { task, answer } for a text
 * challenge or { task, option } for a pick-one question (the option's text).
 */
async function play(helpers, email, compId, moves) {
  const { api, csrf } = await helpers.apiLogin(email);
  try {
    const h = { "x-csrf-token": csrf, "content-type": "application/json" };
    const sel = await api.post("/api/select-competition", { headers: h, data: { competitionId: compId } });
    if (!sel.ok()) throw new Error(`${email} select-competition: ${sel.status()} ${await sel.text()}`);
    for (const mv of moves) {
      const g = await api.get(`/api/tasks/${mv.task}`, { headers: h });
      if (!g.ok()) throw new Error(`${email} GET task: ${g.status()} ${await g.text()}`);
      const t = await g.json();
      let answer = mv.answer;
      if (mv.option !== undefined) {
        const c = (t.choices || []).find((x) => x.text === mv.option);
        if (!c) throw new Error(`${email}: no option "${mv.option}" on "${t.title}"`);
        answer = c.id;
      }
      const s = await api.post(`/api/tasks/${mv.task}/submit`, { headers: h, data: { answer, gradingHash: t.grading_hash } });
      if (!s.ok()) throw new Error(`${email} submit: ${s.status()} ${await s.text()}`);
    }
  } finally {
    await api.dispose();
  }
}

/** Promote a person to organiser (event admin) of one event. */
async function makeOrganiser(adm, compId, userId) {
  await adm.must("POST", `/api/admin/competitions/${compId}/admins`, { userId });
}

/**
 * Remove what a fixture made: events (ended first, since a live event in use
 * cannot be deleted), then their challenges, then the people. A failure is
 * reported (the harness prints it) but never stops the rest.
 */
function teardown(page, adm, made, { ownSession = false } = {}) {
  return async () => {
    // Leave the page first: its SPA must not be running when the token changes.
    await page.goto("about:blank").catch(() => {});
    await adm.refresh();
    const failed = [];
    const del = async (url) => { const r = await adm.call("DELETE", url); if (!r.ok && r.status !== 404) failed.push(`${url}: ${r.status} ${JSON.stringify(r.body)}`); };
    for (const id of made.events || []) {
      await adm.call("POST", `/api/admin/competitions/${id}/end-now`, {});
      await del(`/api/admin/competitions/${id}`);
    }
    for (const id of made.tasks || []) await del(`/api/admin/tasks/${id}`);
    for (const id of made.users || []) await del(`/api/admin/participants/${id}?force=1`);
    for (const id of made.templates || []) await del(`/api/admin/event-templates/${id}`);
    if (made.purgeTemplates) await adm.call("POST", "/api/test/purge-events", { templateTtlMs: 0 });
    if (made.domains) await adm.call("PUT", "/api/admin/team-report-domains", { domains: [] });
    if (ownSession) await adm.api.dispose();
    if (failed.length) throw new Error(failed.join("; "));
  };
}

// The challenge ids of an event, by qualifying key ("developers", …) for its
// qualifying questions.
async function qualifyingIds(adm, compId) {
  const rows = await adm.must("GET", `/api/admin/tasks?competitionId=${encodeURIComponent(compId)}`);
  const out = {};
  for (const r of rows || []) {
    const q = (r.tags || []).find((x) => String(x).startsWith("qualifying:"));
    if (q && (r.competitions || []).some((c) => c.id === compId)) out[q.slice("qualifying:".length)] = r.id;
  }
  return out;
}

module.exports = {
  /**
   * A LIVE Competition, 45 minutes in, with its join link on: four challenges
   * (one hidden from participants), four participants who have played (one
   * challenge tried and solved by nobody, so the attention row has something to
   * say) and two organisers. Returns { id, name }.
   */
  async wsLive({ page, helpers, BASE }) {
    const adm = await pageAdmin(page);
    const t = tag();
    const made = { events: [], tasks: [], users: [] };
    try {
      const comp = await makeEvent(adm, { name: `AppSec Sprint ${t}`, start_time: iso(-45 * MIN), duration_minutes: 180, self_enroll_enabled: true });
      made.events.push(comp.id);
      const c1 = await makeTask(adm, comp.id, { title: "Login form injection", difficulty: "easy", answer: "parameterise" });
      const c2 = await makeTask(adm, comp.id, { title: "Weak session token", difficulty: "medium", answer: "csprng" });
      const c3 = await makeTask(adm, comp.id, { title: "Deserialisation gadget", difficulty: "hard", answer: "allowlist" });
      const c4 = await makeTask(adm, comp.id, { title: "Secrets in the build log", difficulty: "medium", answer: "mask", hidden: true });
      made.tasks.push(c1, c2, c3, c4);
      const people = [];
      for (const p of PEOPLE.slice(0, 4)) people.push(await makePerson(adm, helpers, BASE, p, t));
      made.users.push(...people.map((p) => p.id));
      await enrol(adm, comp.id, people.map((p) => p.id));
      await play(helpers, people[0].email, comp.id, [{ task: c1, answer: "parameterise" }, { task: c2, answer: "csprng" }, { task: c3, answer: "escape it" }]);
      await play(helpers, people[1].email, comp.id, [{ task: c1, answer: "parameterise" }, { task: c2, answer: "md5" }, { task: c2, answer: "csprng" }, { task: c3, answer: "sanitise" }]);
      await play(helpers, people[2].email, comp.id, [{ task: c1, answer: "parameterise" }]);
      await play(helpers, people[3].email, comp.id, [{ task: c1, answer: "escape" }]);
      const orgs = [];
      for (const p of PEOPLE.slice(4, 6)) orgs.push(await makePerson(adm, helpers, BASE, p, t));
      made.users.push(...orgs.map((p) => p.id));
      for (const o of orgs) await makeOrganiser(adm, comp.id, o.id);
      return { id: comp.id, name: comp.name, cleanup: teardown(page, adm, made) };
    } catch (e) {
      await teardown(page, adm, made)().catch(() => {});
      throw e;
    }
  },

  /** A LIVE Competition with its join link on and nothing else. Returns { id, name }. */
  async wsJoin({ page }) {
    const adm = await pageAdmin(page);
    const t = tag();
    const made = { events: [], tasks: [] };
    try {
      const comp = await makeEvent(adm, { name: `Partner Day Booth ${t}`, start_time: iso(-20 * MIN), duration_minutes: 120, self_enroll_enabled: true });
      made.events.push(comp.id);
      made.tasks.push(await makeTask(adm, comp.id, { title: "Open redirect", answer: "allowlist" }));
      return { id: comp.id, name: comp.name, cleanup: teardown(page, adm, made) };
    } catch (e) {
      await teardown(page, adm, made)().catch(() => {});
      throw e;
    }
  },

  /**
   * An UPCOMING Competition, three hours out, join link on, nobody enrolled,
   * three challenges of which one is hidden: its "Ready to start?" checklist
   * shows a done, a to-do and an optional item. Returns { id, name }.
   */
  async wsUpcoming({ page }) {
    const adm = await pageAdmin(page);
    const t = tag();
    const made = { events: [], tasks: [] };
    try {
      const comp = await makeEvent(adm, { name: `Secure Code Kickoff ${t}`, start_time: iso(3 * HOUR), duration_minutes: 120, self_enroll_enabled: true });
      made.events.push(comp.id);
      made.tasks.push(await makeTask(adm, comp.id, { title: "Path traversal", difficulty: "easy", answer: "normalise" }));
      made.tasks.push(await makeTask(adm, comp.id, { title: "SSRF via webhook", difficulty: "medium", answer: "deny-internal" }));
      made.tasks.push(await makeTask(adm, comp.id, { title: "JWT none algorithm", difficulty: "hard", answer: "pin-alg", hidden: true }));
      return { id: comp.id, name: comp.name, cleanup: teardown(page, adm, made) };
    } catch (e) {
      await teardown(page, adm, made)().catch(() => {});
      throw e;
    }
  },

  /**
   * An ENDED, ranked Competition with its certificates issued: four people with
   * four different scores (a podium and a participation), ended with End now,
   * then one forced certificate-dispatch pass (the test-only tick: under test
   * nothing runs by itself). Returns { id, name }.
   */
  async wsEnded({ page, helpers, BASE }) {
    const adm = await pageAdmin(page);
    const t = tag();
    const made = { events: [], tasks: [], users: [] };
    try {
      const comp = await makeEvent(adm, { name: `Spring CTF ${t}`, start_time: iso(-50 * MIN), duration_minutes: 120 });
      made.events.push(comp.id);
      const c1 = await makeTask(adm, comp.id, { title: "Stored XSS in comments", difficulty: "easy", answer: "encode" });
      const c2 = await makeTask(adm, comp.id, { title: "IDOR on invoices", difficulty: "medium", answer: "authorise" });
      const c3 = await makeTask(adm, comp.id, { title: "Race in the coupon API", difficulty: "hard", answer: "lock" });
      made.tasks.push(c1, c2, c3);
      const people = [];
      for (const p of PEOPLE.slice(0, 4)) people.push(await makePerson(adm, helpers, BASE, p, t));
      made.users.push(...people.map((p) => p.id));
      await enrol(adm, comp.id, people.map((p) => p.id));
      // Nobody finishes everything before the end, so the all-solved auto-end
      // cannot fire (fixture checklist item 1): End now ends it.
      await play(helpers, people[0].email, comp.id, [{ task: c1, answer: "encode" }, { task: c2, answer: "authorise" }, { task: c3, answer: "retry" }]);
      await play(helpers, people[1].email, comp.id, [{ task: c1, answer: "encode" }, { task: c2, answer: "authorise" }]);
      await play(helpers, people[2].email, comp.id, [{ task: c1, answer: "encode" }, { task: c2, answer: "hide the id" }]);
      await play(helpers, people[3].email, comp.id, [{ task: c1, answer: "strip tags" }]);
      await adm.must("POST", `/api/admin/competitions/${comp.id}/end-now`, {});
      await adm.must("POST", "/api/test/certificate-dispatch-tick", { force: true });
      const certs = await adm.must("GET", `/api/admin/competitions/${comp.id}/certificates`);
      if (!Array.isArray(certs.certificates) || certs.certificates.length < 4) {
        throw new Error(`wsEnded: expected 4 issued certificates, got ${JSON.stringify(certs).slice(0, 400)}`);
      }
      return { id: comp.id, name: comp.name, cleanup: teardown(page, adm, made) };
    } catch (e) {
      await teardown(page, adm, made)().catch(() => {});
      throw e;
    }
  },

  /**
   * A LIVE Competition with the four qualifying questions, five people who
   * answered them (hot, warm and cold leads) and an event team (Marketing, SE,
   * SDR, a sales manager) with targets, so Team & reports and its email preview
   * have something to show. Sets the allowed team-report domains (a global
   * setting) and puts them back to the default, none. Returns { id, name }.
   */
  async wsTeam({ page, helpers, BASE }) {
    const adm = await pageAdmin(page);
    const t = tag();
    const made = { events: [], tasks: [], users: [], domains: true };
    try {
      await adm.must("PUT", "/api/admin/team-report-domains", { domains: [DOMAIN] });
      const comp = await makeEvent(adm, { name: `DevSecOps Summit ${t}`, start_time: iso(-40 * MIN), duration_minutes: 180, self_enroll_enabled: true, add_qualifying: true });
      made.events.push(comp.id);
      const c1 = await makeTask(adm, comp.id, { title: "Hard-coded API key", difficulty: "easy", answer: "vault" });
      const c2 = await makeTask(adm, comp.id, { title: "XXE in the importer", difficulty: "medium", answer: "disable-dtd" });
      made.tasks.push(c1, c2);
      const q = await qualifyingIds(adm, comp.id);
      made.tasks.push(...Object.values(q));
      if (!q.developers || !q.evaluating || !q.follow_up || !q.scanner) throw new Error(`wsTeam: qualifying questions missing: ${JSON.stringify(q)}`);
      const people = [];
      for (const p of PEOPLE.slice(0, 5)) people.push(await makePerson(adm, helpers, BASE, p, t));
      made.users.push(...people.map((p) => p.id));
      await enrol(adm, comp.id, people.map((p) => p.id));
      const answers = [
        { developers: "1000+", scanner: "Open source", evaluating: "Yes, within 3 months", follow_up: "Yes", solve: [c1, c2] },
        { developers: "250–999", scanner: "Commercial", evaluating: "No", follow_up: "No", solve: [c1] },
        { developers: "50–249", scanner: "None", evaluating: "Yes, in 3–6 months", follow_up: "No", solve: [c1, c2] },
        { developers: "1–49", scanner: "Not sure", evaluating: "No", follow_up: "No", solve: [] },
        { developers: "250–999", scanner: "None", evaluating: "Yes, in 6–12 months", follow_up: "Yes", solve: [c2] },
      ];
      const key = { [c1]: "vault", [c2]: "disable-dtd" };
      for (let i = 0; i < people.length; i++) {
        const a = answers[i];
        const moves = a.solve.map((id) => ({ task: id, answer: key[id] }));
        for (const k of ["developers", "scanner", "evaluating", "follow_up"]) moves.push({ task: q[k], option: a[k] });
        await play(helpers, people[i].email, comp.id, moves);
      }
      for (const [role, name, local] of [["marketing", "Maya Fischer", "maya.fischer"], ["se", "Sam Okafor", "sam.okafor"], ["sdr", "Dana Ruiz", "dana.ruiz"], ["sales_manager", "Lee Chen", "lee.chen"]]) {
        await adm.must("POST", `/api/admin/competitions/${comp.id}/team`, { role, name, email: `${local}@${DOMAIN}` });
      }
      await adm.must("PUT", `/api/admin/competitions/${comp.id}/team-targets`, { lead_target: 8, hot_lead_target: 3 });
      return { id: comp.id, name: comp.name, cleanup: teardown(page, adm, made) };
    } catch (e) {
      await teardown(page, adm, made)().catch(() => {});
      throw e;
    }
  },

  /**
   * Thirty-two upcoming events, so the Events list (30 rows a page) has a second
   * page and its pager's Next and Last are live.
   */
  async wsManyEvents({ page }) {
    const adm = await pageAdmin(page);
    const t = tag();
    const made = { events: [] };
    try {
      for (let i = 1; i <= 32; i++) {
        const c = await makeEvent(adm, { name: `WS Pager ${String(i).padStart(2, "0")} ${t}`, start_time: iso((24 + i) * HOUR), duration_minutes: 60 });
        made.events.push(c.id);
      }
      return { count: made.events.length, cleanup: teardown(page, adm, made) };
    } catch (e) {
      await teardown(page, adm, made)().catch(() => {});
      throw e;
    }
  },

  /**
   * Two templates of this fixture's own, soft-deleted, so the New event page
   * lists them under Recently deleted. Cleanup purges soft-deleted templates
   * (the test-only retention pass with a zero window).
   */
  async wsDeletedTemplates({ page }) {
    const adm = await pageAdmin(page);
    const t = tag();
    const made = { templates: [], purgeTemplates: true };
    try {
      for (const [name, kind, desc, minutes] of [[`Partner day booth ${t}`, "booth", "The stand at partner days: walk-ups scan and play.", 240], [`Quarterly CTF ${t}`, "tournament", "Two hours, ranked, certificates for the podium.", 120]]) {
        const d = await adm.must("POST", "/api/admin/event-templates", { name, description: desc, event_kind: kind, settings: { duration_minutes: minutes } });
        made.templates.push(d.template.id);
        await adm.must("DELETE", `/api/admin/event-templates/${d.template.id}`);
      }
      return { cleanup: teardown(page, adm, made) };
    } catch (e) {
      await teardown(page, adm, made)().catch(() => {});
      throw e;
    }
  },

  /**
   * An event admin (organiser) of one upcoming event: a template pick opens the
   * quick spin for them (a global admin's pick opens the full create form
   * instead). Runs BEFORE the page signs in, on a superadmin session of its own.
   * Returns { email }: the route signs the page in as them.
   */
  async wsEventAdmin({ page, helpers, BASE }) {
    const adm = await ownAdmin(helpers);
    const t = tag();
    const made = { events: [], users: [] };
    try {
      const comp = await makeEvent(adm, { name: `Regional Roadshow ${t}`, start_time: iso(26 * HOUR), duration_minutes: 90 });
      made.events.push(comp.id);
      const p = await makePerson(adm, helpers, BASE, { first: "Nadia", last: "Haddad", company: "Northwind Traders", title: "Field Marketing", avatar: "🦄" }, t);
      made.users.push(p.id);
      await makeOrganiser(adm, comp.id, p.id);
      return { email: p.email, cleanup: teardown(page, adm, made, { ownSession: true }) };
    } catch (e) {
      await teardown(page, adm, made, { ownSession: true })().catch(() => {});
      throw e;
    }
  },
};
