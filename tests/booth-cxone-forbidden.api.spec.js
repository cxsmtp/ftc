// @ts-check
//
// A BOOTH EVENT NEVER CREATES CHECKMARX ONE ACCOUNTS (owner's decision, 27 Nov
// 2026). A walk-up at a stand for two minutes never opens the product, so the
// kind carries a PROHIBITION (`lib/event-policy.js` `cxoneProvisioning:
// "forbidden"`, wire `cxone_provisioning`), not merely the `cxoneDisabledDefault`
// seed it had before, which an admin (or the API) could overrule:
//
//   * create and PUT refuse a Booth Event with accounts on, by name
//     (400 `cxone_provisioning_forbidden`), and store them off otherwise;
//   * a kind change to Booth turns them off, recorded in the `edited` event;
//   * the per-event key override is refused for a Booth Event;
//   * a template of the kind refuses them, and a clone INTO the kind turns them
//     off and names `cxone_provisioning` in `forced_settings`;
//   * the provisioning gate (`cxOneProvisionUser`) refuses a Booth Event
//     whatever its column holds (the child-process harness, which reaches it).
//
// Each refusal sits beside a Competition CONTROL that the same request is
// accepted for, so a build that refuses every kind cannot pass.
const { test, expect } = require("./isolated-test");
const { apiLogin, BASE } = require("./helpers");
const { H, uniq } = require("./event-admin-helpers");
const { provision } = require("./cxone-harness-client");

test.use({ baseURL: BASE });

const HOUR = 3600e3;

async function create(api, csrf, kind, extra = {}) {
  return api.post("/api/admin/competitions", {
    headers: H(csrf),
    data: { name: `Booth CxOne ${uniq(kind)}`, event_kind: kind, start_time: new Date(Date.now() + 24 * HOUR).toISOString(), duration_minutes: 60, ...extra },
  });
}
async function row(api, id) {
  const r = await api.get("/api/admin/competitions");
  expect(r.ok()).toBeTruthy();
  const list = await r.json();
  return (Array.isArray(list) ? list : list.competitions || []).find(c => c.id === id);
}
const idOf = async (r) => { const d = await r.json(); return (d.competition && d.competition.id) || d.id; };

test.describe("a Booth Event never creates Checkmarx One accounts", () => {
  let api, csrf;
  test.beforeAll(async () => { ({ api, csrf } = await apiLogin("superadmin")); });
  test.afterAll(async () => { await api?.dispose(); });

  test("create: accounts ON is refused for a Booth Event, accepted for a Competition (CONTROL); absent stores them off", async () => {
    const refused = await create(api, csrf, "booth", { cxone_disabled: false });
    expect(refused.status(), await refused.text()).toBe(400);
    const body = await refused.json();
    expect(body.code).toBe("cxone_provisioning_forbidden");
    expect(body.error).toMatch(/never creates Checkmarx One accounts/);

    const ok = await create(api, csrf, "tournament", { cxone_disabled: false });
    expect(ok.ok(), `CONTROL: a Competition may create accounts: ${ok.status()}`).toBeTruthy();
    expect((await row(api, await idOf(ok))).cxone_disabled, "CONTROL: stored on").toBeFalsy();

    const quiet = await create(api, csrf, "booth");
    expect(quiet.ok(), await quiet.text()).toBeTruthy();
    const booth = await row(api, await idOf(quiet));
    expect(booth.cxone_disabled, "a Booth Event saved with nothing said stores accounts off").toBeTruthy();
    expect(booth.policy.cxone_provisioning).toBe("forbidden");
  });

  test("PUT: accounts ON is refused on a Booth Event; the off echo is accepted; a Competition may turn them on (CONTROL)", async () => {
    const b = await create(api, csrf, "booth");
    const bid = await idOf(b);
    const put = (id, data) => api.put(`/api/admin/competitions/${id}`, { headers: H(csrf), data });
    const r1 = await put(bid, { cxone_disabled: false });
    expect(r1.status(), await r1.text()).toBe(400);
    expect((await r1.json()).code).toBe("cxone_provisioning_forbidden");
    expect((await row(api, bid)).cxone_disabled, "nothing was written").toBeTruthy();
    const r2 = await put(bid, { cxone_disabled: true });
    expect(r2.ok(), `the off echo saves: ${await r2.text()}`).toBeTruthy();

    const t = await create(api, csrf, "tournament", { cxone_disabled: true });
    const tid = await idOf(t);
    const r3 = await put(tid, { cxone_disabled: false });
    expect(r3.ok(), `CONTROL: ${await r3.text()}`).toBeTruthy();
    expect((await row(api, tid)).cxone_disabled, "CONTROL: stored on").toBeFalsy();
  });

  test("a kind change to Booth turns accounts off and records it; the reverse keeps the stored value", async () => {
    const t = await create(api, csrf, "tournament", { cxone_disabled: false });
    const id = await idOf(t);
    const r = await api.put(`/api/admin/competitions/${id}`, { headers: H(csrf), data: { event_kind: "booth" } });
    expect(r.ok(), await r.text()).toBeTruthy();
    const after = await row(api, id);
    expect(after.event_kind).toBe("booth");
    expect(after.cxone_disabled, "the change to Booth turned accounts off").toBeTruthy();
    const ev = await (await api.get(`/api/admin/competitions/${id}/events`)).json();
    const edited = (ev.events || ev).filter(e => e.event_type === "edited").map(e => typeof e.details === "string" ? JSON.parse(e.details) : e.details);
    expect(edited.some(d => d && d.changes && d.changes.cxone_disabled && d.changes.cxone_disabled.from === false && d.changes.cxone_disabled.to === true),
      `the forced change is recorded: ${JSON.stringify(edited)}`).toBe(true);
    // Back to a Competition: nothing forces it on (a seed never overwrites).
    const back = await api.put(`/api/admin/competitions/${id}`, { headers: H(csrf), data: { event_kind: "tournament" } });
    expect(back.ok(), await back.text()).toBeTruthy();
    expect((await row(api, id)).cxone_disabled, "CONTROL: the off value stays").toBeTruthy();
  });

  test("the per-event key override is refused on a Booth Event and accepted on a Competition (CONTROL)", async () => {
    const b = await idOf(await create(api, csrf, "booth"));
    const r = await api.put(`/api/admin/competitions/${b}/cxone`, { headers: H(csrf), data: { cxone_group_name: "stand" } });
    expect(r.status(), await r.text()).toBe(400);
    expect((await r.json()).code).toBe("cxone_provisioning_forbidden");
    const t = await idOf(await create(api, csrf, "tournament"));
    const ok = await api.put(`/api/admin/competitions/${t}/cxone`, { headers: H(csrf), data: { cxone_group_name: "hall" } });
    expect(ok.ok(), `CONTROL: ${await ok.text()}`).toBeTruthy();
  });

  test("a Booth template refuses accounts on; a Competition template keeps them (CONTROL); a clone into Booth turns them off by name", async () => {
    const tpl = (kind, settings) => api.post("/api/admin/event-templates", { headers: H(csrf), data: { name: `Tpl ${uniq(kind)}`, event_kind: kind, settings } });
    const r = await tpl("booth", { duration_minutes: 60, cxone_disabled: false });
    expect(r.status(), await r.text()).toBe(400);
    expect((await r.json()).code).toBe("cxone_provisioning_forbidden");
    const ok = await tpl("tournament", { duration_minutes: 60, cxone_disabled: false });
    expect(ok.ok(), `CONTROL: ${await ok.text()}`).toBeTruthy();

    const src = await idOf(await create(api, csrf, "tournament", { cxone_disabled: false }));
    const clone = await api.post(`/api/admin/competitions/${src}/clone`, {
      headers: H(csrf), data: { name: `Clone ${uniq("booth")}`, event_kind: "booth", start_time: new Date(Date.now() + 48 * HOUR).toISOString() },
    });
    expect(clone.ok(), await clone.text()).toBeTruthy();
    const d = await clone.json();
    expect(d.forced_settings, JSON.stringify(d)).toContain("cxone_provisioning");
    expect((await row(api, (d.competition && d.competition.id) || d.id)).cxone_disabled).toBeTruthy();
  });
});

test.describe("the provisioning gate refuses a Booth Event whatever its column holds", () => {
  test("CONTROL: a Competition's participant is provisioned", () => {
    const o = provision({});
    expect(o.provisioned.map(e => e.details.success), o.dump()).toEqual([true]);
  });
  test("a Booth Event with cxone_disabled 0 makes no call and records nothing", () => {
    const o = provision({ eventKind: "booth" });
    expect(o.calls, o.dump()).toEqual([]);
    expect(o.provisioned, "no cxone_provisioned event").toEqual([]);
  });
});
