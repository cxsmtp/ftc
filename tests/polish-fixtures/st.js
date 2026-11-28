"use strict";
// @ts-check
//
// Polish-capture fixture for the staff-teams screens of .claude/screens.json:
// Settings → People → Staff teams, its dialogs, and the two event doors (Team &
// reports' "Add a staff team", the Organisers card's "Add a staff team as
// organisers"). It makes its OWN team, through the routes the UI uses, on the
// PAGE's superadmin session (run it after `apiLogin superadmin` and before
// `goto /`, as tests/polish-fixtures/ws.js explains), and deletes it again.

let _seq = 0;
function tag() {
  _seq = (_seq + 1) % 1296;
  return Date.now().toString(36).slice(-5) + _seq.toString(36).padStart(2, "0");
}

module.exports = {
  /** A staff team of four (three with a default role). Returns { id, name }. */
  async staffTeams({ page }) {
    const api = page.request;
    const me = await api.get("/api/admin/me");
    if (!me.ok() || (await me.json()).isSuperAdmin !== true) throw new Error("staffTeams works on the page's superadmin session: put `apiLogin superadmin` before it and `goto /` after it");
    let token = (await (await api.get("/api/csrf-token")).json()).csrfToken;
    const h = () => ({ "x-csrf-token": token, "content-type": "application/json" });
    const t = tag();
    const r = await api.post("/api/admin/staff-teams", { headers: h(), data: { name: `EMEA field team ${t}` } });
    if (r.status() !== 201) throw new Error(`staffTeams: create: ${r.status()} ${await r.text()}`);
    const team = (await r.json()).team;
    for (const [name, local, default_role] of [["Maya Fischer", "maya.fischer", "marketing"], ["Sam Okafor", "sam.okafor", "se"], ["Dana Ruiz", "dana.ruiz", "sdr"], ["Lee Chen", "lee.chen", null]]) {
      const m = await api.post(`/api/admin/staff-teams/${team.id}/members`, { headers: h(), data: { name, email: `${local}.${t}@northwind-ws.com`, default_role } });
      if (m.status() !== 201) throw new Error(`staffTeams: member ${name}: ${m.status()} ${await m.text()}`);
    }
    return {
      id: team.id, name: team.name,
      cleanup: async () => {
        await page.goto("about:blank").catch(() => {});
        token = (await (await api.get("/api/csrf-token")).json()).csrfToken;
        await api.delete(`/api/admin/staff-teams/${team.id}`, { headers: h() });
      },
    };
  },
};
