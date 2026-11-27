// v8.1.0 — PR 19: group-clash detection is gated on group_leaderboard_enabled.
//
// The rule the three detectors enforce — a participant may not be in two groups
// bound to the SAME competition — exists solely because the group board averages
// each participant into exactly one group. With no team board there is no
// ambiguity to prevent, so the 409 was refusing a legitimate arrangement.
//
// This is a REAL behaviour change to `tournament` events, not just a Program
// enabler: an admin with two groups sharing a member and the board switched off
// gets a success where they used to get a 409. That is why it belongs in a phase
// whose outcome permits behaviour change, and why the existing clash tests had to
// grow `group_leaderboard_enabled: true` — with the board off they were asserting
// a rule that no longer applies.
const { test, expect } = require("./isolated-test");
const { registerPost } = require("./helpers");
const { freshCtx, getSuperadminPass } = require("./helpers");

const H = (csrf) => ({ "x-csrf-token": csrf, "content-type": "application/json" });
const TAG = `gc${Date.now().toString(36)}`;

async function sa() {
  const { api, csrf: c0 } = await freshCtx();
  const r = await api.post("/api/login", { headers: H(c0), data: { email: "superadmin", password: getSuperadminPass() } });
  expect(r.ok(), `superadmin login: ${r.status()}`).toBeTruthy();
  return { api, csrf: (await (await api.get("/api/csrf-token")).json()).csrfToken };
}

test.describe("v8.1.0 — clash detection follows the team board", () => {
  test("board OFF allows the clash, board ON still refuses it", async () => {
    const { api, csrf } = await sa();
    const h = H(csrf);
    try {
      const t = Date.now();
      const mkComp = async (label, boardOn) => {
        const r = await api.post("/api/admin/competitions", {
          headers: h,
          data: {
            name: `${TAG} ${label}`, start_time: new Date(t + 3600e3).toISOString(),
            duration_minutes: 120, timezone: "UTC", group_leaderboard_enabled: boardOn,
          },
        });
        expect(r.ok(), `create ${label}: ${await r.text()}`).toBeTruthy();
        return (await r.json()).competition.id;
      };
      const mkUser = async (n) => {
        const email = `${TAG}-${n}@company.example`;
        const reg = await registerPost(api, "/api/register", {
          headers: h,
          data: {
            firstName: "Clash", lastName: `U${n}`, nickname: `${TAG}_${n}`, email,
            company: "Acme", title: "Engineer", country: "US", timezone: "America/New_York",
            password: "testpass123", jobFunction: "Software Developer / Engineer", city: "Testville",
          },
        });
        expect(reg.status(), await reg.text()).toBe(200);
        const l = await (await api.get(`/api/admin/participants?limit=500&search=${encodeURIComponent(email)}`)).json();
        const u = (l.participants || []).find(p => p.email === email);
        expect(u).toBeTruthy();
        return u.id;
      };
      const mkGroup = async (label, userIds) => {
        const r = await api.post("/api/admin/groups", { headers: h, data: { name: `${TAG} ${label}`, userIds: userIds || [] } });
        expect(r.ok(), `group ${label}: ${await r.text()}`).toBeTruthy();
        return (await r.json()).group.id;
      };
      const bind = (g, c) => api.post("/api/admin/competitions/assign", { headers: h, data: { groupIds: [g], competitionIds: [c] } });

      const uid = await mkUser("shared");
      const gA = await mkGroup("A", [uid]);
      const gB = await mkGroup("B", [uid]);   // the SAME member in both

      // Board OFF — the arrangement is legitimate and must be allowed.
      const off = await mkComp("BoardOff", false);
      expect((await bind(gA, off)).ok(), "first bind").toBeTruthy();
      const r2 = await bind(gB, off);
      expect(r2.ok(), `board OFF must ALLOW a shared member: ${r2.status()} ${await r2.text()}`).toBeTruthy();

      // Board ON — the positive control. Without it, "the clash was allowed" is
      // equally satisfied by a build where detection never fires at all.
      const on = await mkComp("BoardOn", true);
      expect((await bind(gA, on)).ok(), "first bind").toBeTruthy();
      const r4 = await bind(gB, on);
      expect(r4.status(), "board ON still refuses").toBe(409);
      const body = await r4.json();
      expect(body.clash, "…and still names the offenders").toBeTruthy();
    } finally { await api.dispose(); }
  });

  test("the gate is PER COMPETITION, not an early return", async () => {
    // THE DISCRIMINATING TEST. detectMemberAddClashes and
    // detectMultiGroupAddClashes scan a group's WHOLE set of bound competitions,
    // so gating with an early return would silently drop a real clash against a
    // board-enabled competition the same group is also bound to. Here group A is
    // bound to BOTH a board-off and a board-on competition, and adding the shared
    // member must still be refused — because of the board-on one.
    const { api, csrf } = await sa();
    const h = H(csrf);
    try {
      const t = Date.now();
      const mkComp = async (label, boardOn) => {
        const r = await api.post("/api/admin/competitions", {
          headers: h,
          data: {
            name: `${TAG} PC ${label}`, start_time: new Date(t + 3600e3).toISOString(),
            duration_minutes: 120, timezone: "UTC", group_leaderboard_enabled: boardOn,
          },
        });
        expect(r.ok(), await r.text()).toBeTruthy();
        return (await r.json()).competition.id;
      };
      const email = `${TAG}-pc@company.example`;
      const reg = await registerPost(api, "/api/register", {
        headers: h,
        data: {
          firstName: "Per", lastName: "Comp", nickname: `${TAG}_pc`, email,
          company: "Acme", title: "Engineer", country: "US", timezone: "America/New_York",
          password: "testpass123", jobFunction: "Software Developer / Engineer", city: "Testville",
        },
      });
      expect(reg.status(), await reg.text()).toBe(200);
      const l = await (await api.get(`/api/admin/participants?limit=500&search=${encodeURIComponent(email)}`)).json();
      const uid = (l.participants || []).find(p => p.email === email).id;

      const mkGroup = async (label, userIds) => {
        const r = await api.post("/api/admin/groups", { headers: h, data: { name: `${TAG} PC ${label}`, userIds: userIds || [] } });
        expect(r.ok(), await r.text()).toBeTruthy();
        return (await r.json()).group.id;
      };
      const gA = await mkGroup("A", [uid]);     // holds the member
      const gB = await mkGroup("B", []);        // empty, so the BIND itself is clean

      const off = await mkComp("Off", false);
      const on = await mkComp("On", true);
      const bind = (g, c) => api.post("/api/admin/competitions/assign", { headers: h, data: { groupIds: [g], competitionIds: [c] } });
      // gB is bound to BOTH; gA (which holds the member) is bound to both too.
      for (const c of [off, on]) {
        expect((await bind(gA, c)).ok(), "bind A").toBeTruthy();
        expect((await bind(gB, c)).ok(), "bind B — empty, so no clash yet").toBeTruthy();
      }

      // Now add the shared member to gB. An early-return gate that bailed on the
      // FIRST board-off competition it saw would let this through.
      const add = await api.post(`/api/admin/groups/${gB}/members`, { headers: h, data: { userIds: [uid] } });
      expect(add.status(), "the board-ON competition in the set still refuses it").toBe(409);
      const raw = JSON.stringify(await add.json());
      expect(raw, "…and names the board-ON competition").toContain("PC On");
      expect(raw, "…and NOT the board-off one, which has no board to be ambiguous about")
        .not.toContain("PC Off");
    } finally { await api.dispose(); }
  });
});
