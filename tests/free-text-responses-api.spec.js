// @ts-check
//
// v8.9.0 — GET /api/admin/competitions/:id/free-text-responses: the JSON the
// FOCUSED participants CSV reads. Every `any`-type challenge assigned to one
// event, plus the latest correct submission each participant made to each.
//
// SCOPE OF THIS FILE: the response SHAPE and the refusal ladder only. The `any`
// answer type does not exist at this step of the release, so no challenge can
// be populated here. The populated arms — a real free-text response returned
// verbatim, the latest-correct-row rule, the `is_correct` filter on a switched
// challenge, the event-admin in-scope/out-of-scope pair driven through a real
// organiser, and the `data_exported` line via findLogLine — live in
// tests/free-text-csv.spec.js, which a later step adds. The event-admin cell
// is meanwhile covered by tests/event-admin-matrix.spec.js.
//
// What THIS file pins without that type is the one decision the endpoint takes
// the OTHER way from its sibling: there is NO upcoming-status gate. The
// activity export answers 400 `competition_not_started` for an upcoming event;
// this endpoint must answer 200, because the participants CSV it feeds is
// exported before the doors open as a matter of course.
//
// Fixture checklist (CLAUDE.md): own competition, own challenge, nothing
// borrowed from the seed; no participant acts, so no auto-end can fire.
const { test, expect } = require("./isolated-test");
const { apiLogin, freshCtx, BASE } = require("./helpers");
const crypto = require("crypto");

test.use({ baseURL: BASE });

const H = (csrf) => ({ "x-csrf-token": csrf, "content-type": "application/json" });
const uniq = () => `${Date.now().toString(36)}${crypto.randomBytes(3).toString("hex")}`;
const URL_FOR = (id) => `/api/admin/competitions/${encodeURIComponent(id)}/free-text-responses`;

test.describe("free-text responses — shape and refusal ladder (v8.9.0)", () => {
  test("an UPCOMING event holding only a text challenge answers 200 with the empty shape", async () => {
    const { api: sa, csrf } = await apiLogin("superadmin");
    try {
      const t = uniq();
      // UPCOMING on purpose — see the file header. Starts in an hour, so it
      // cannot go live under the test.
      const comp = await sa.post("/api/admin/competitions", { headers: H(csrf), data: {
        name: `FTR ${t}`, start_time: new Date(Date.now() + 3_600_000).toISOString(), duration_minutes: 120,
      }});
      expect(comp.status(), await comp.text()).toBe(200);
      const compId = (await comp.json()).competition.id;

      // A `text` challenge assigned to it is the TYPE-FILTER CONTROL: with no
      // `any` type in existence every assigned challenge is a non-`any` one, so
      // a build that returned every assignment fails here rather than passing
      // on an event that merely has nothing assigned.
      const task = await sa.post("/api/admin/tasks", { headers: H(csrf), data: {
        title: `FTR text ${t}`, description: "<p>d</p>", difficulty: "easy", answer_type: "text",
        correct_answer: "right", explanation: "<p>e</p>", hint: "a hint", status: "published",
      }});
      expect(task.status(), await task.text()).toBe(200);
      const taskId = (await task.json()).id;
      const asg = await sa.post(`/api/admin/tasks/${taskId}/competitions`, {
        headers: H(csrf), data: { competitionIds: [compId] },
      });
      expect(asg.status(), await asg.text()).toBe(200);

      const r = await sa.get(URL_FOR(compId));
      expect(r.status(), await r.text()).toBe(200);
      // Exact shape: both keys present, both empty, nothing else on the wire.
      expect(await r.json()).toEqual({ challenges: [], responses: [] });

      // The sibling REFUSES this same event, which is what says the missing gate
      // here is a decision rather than a build where no gate works anywhere.
      const sib = await sa.get(`/api/admin/export/competition-activity?competitionId=${encodeURIComponent(compId)}`);
      expect(sib.status(), "the activity export still gates on upcoming").toBe(400);
      expect((await sib.json()).code).toBe("competition_not_started");
    } finally { await sa.dispose(); }
  });

  test("an unknown event id is a named 404, not a 500", async () => {
    const { api: sa } = await apiLogin("superadmin");
    try {
      const r = await sa.get(URL_FOR(`no-such-event-${uniq()}`));
      expect(r.status(), await r.text()).toBe(404);
      expect(await r.json()).toEqual({ error: "Event not found" });
    } finally { await sa.dispose(); }
  });

  test("an anonymous caller is refused before the event is even looked up", async () => {
    const { api } = await freshCtx();
    try {
      // Auth guard BEFORE the lookup (and before the limiter): an unknown id
      // from an anonymous caller is 401, never 404 — the endpoint discloses
      // nothing about which events exist to somebody who is not signed in.
      const r = await api.get(URL_FOR(`no-such-event-${uniq()}`));
      expect(r.status(), await r.text()).toBe(401);
    } finally { await api.dispose(); }
  });
});
