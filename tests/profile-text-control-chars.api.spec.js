// @ts-check
//
// SINGLE-LINE PROFILE TEXT CARRIES NO CONTROL CHARACTER.
//
// Names, company, job title, city, country, job function, salutation, phone and the two
// certificate-name fields reach mail, CSV exports, certificates and logs as
// stored. `lib/util.js` `profileTextOk` is the one predicate (C0, DEL and C1
// refused; letters of every script legal), asked at every write door:
// sign-up, the profile save, the admin profile edit (never swallowed by its
// keep-what-is-there rule), Users & roles Add user, the desk invite, and the
// participant import (which skips and counts the row, shown to the operator).
// Each door is held by value: U+0007, U+001B and U+0085 refused with the named
// code and field and a message naming the field in words, the
// stored row unchanged; Müller, 张伟 and محمد accepted. The value is checked as
// sent, before any trim, so an edge tab or line break is refused at sign-up and
// the desk invite as everywhere else.
const { test, expect } = require("./isolated-test");
const { apiLogin, freshCtx, registerPost, codeLogin, TEST_DB_PATH, BASE } = require("./helpers");

const H = (csrf) => ({ "x-csrf-token": csrf, "content-type": "application/json" });
const BEL = "\u0007", ESC = "\u001b", NEL = "\u0085";
const CODE = "profile_text_control_chars";
let seq = 0;
const stamp = () => `${Date.now()}${++seq}`;
const addr = (tag) => `${tag}-${stamp()}@ctlchars.example`;

function row(where, arg) {
  const Database = require("better-sqlite3");
  const db = new Database(TEST_DB_PATH, { readonly: true });
  try {
    return db.prepare(`SELECT id, first_name, last_name, company, title, city, country, job_function, personal_title, phone,
      certificate_given_name, certificate_family_name, updated_at FROM users WHERE ${where}`).get(arg) || null;
  } finally { db.close(); }
}
const byEmail = (email) => row("email = ? COLLATE NOCASE", email);
const byId = (id) => row("id = ?", id);

const FORM = { company: "Acme", title: "Engineer", country: "GB", timezone: "Europe/London" };

async function signUp(email, fields) {
  const { api, csrf } = await freshCtx();
  try {
    const r = await registerPost(api, "/api/register", { headers: H(csrf), data: { firstName: "Ann", lastName: "Lee", ...FORM, ...fields, email }, keepState: true });
    return { status: r.status(), body: await r.json() };
  } finally { await api.dispose(); }
}

async function signIn(email) {
  const { api } = await freshCtx();
  const r = await codeLogin(api, email);
  expect(r.ok(), `${email} signs in: ${await r.text()}`).toBe(true);
  const csrf = (await (await api.get("/api/csrf-token")).json()).csrfToken;
  return { api, csrf };
}

// The forms show only `error`, so it names the field in words:
// a person cannot find a character they cannot see without being told where.
const LABEL = {
  first_name: "First name", last_name: "Last name", company: "Company", title: "Job title", city: "City",
  country: "Country", job_function: "Job function", personal_title: "Salutation", phone: "Phone",
  certificate_given_name: "Certificate given name", certificate_family_name: "Certificate family name",
};
const SENTENCE = (field) => `${LABEL[field]} cannot contain control characters (line breaks, tabs or other invisible codes).`;
const refused = (status, body, field) => {
  expect({ status, code: body.code, field: body.field, error: body.error }, JSON.stringify(body))
    .toEqual({ status: 400, code: CODE, field, error: SENTENCE(field) });
};

test.describe("control characters in single-line profile text", () => {
  /** @type {{email: string, id: string}} */
  let person;
  /** @type {{email: string, id: string}} */
  let admin;

  // Each test owns these two, built here rather than by an earlier test.
  test.beforeAll(async () => {
    const email = addr("person");
    const r = await signUp(email, { firstName: "Ann", lastName: "Lee", city: "Leeds" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    person = { email, id: byEmail(email).id };
    const { api, csrf } = await apiLogin("superadmin");
    try {
      const aEmail = addr("admin");
      const a = await api.post("/api/admin/users", { headers: H(csrf), data: { email: aEmail, role: "admin", first_name: "Reg", last_name: "Admin" } });
      expect(a.status(), await a.text()).toBe(200);
      admin = { email: aEmail, id: byEmail(aEmail).id };
    } finally { await api.dispose(); }
  });

  test("every profile text field has its form label, and the refusal names it", async () => {
    const util = require("../lib/util");
    expect(Object.keys(util.PROFILE_TEXT_LABELS).sort(), "one label per field, no stale entry").toEqual([...util.PROFILE_TEXT_FIELDS].sort());
    expect(util.PROFILE_TEXT_LABELS).toEqual(LABEL);
    for (const f of util.PROFILE_TEXT_FIELDS) expect(util.profileTextControlBody(f)).toEqual({ error: SENTENCE(f), code: CODE, field: f });
    // CONTROL: two fields never share a sentence, so a fixed wording fails here.
    expect(new Set(util.PROFILE_TEXT_FIELDS.map((f) => util.profileTextControlBody(f).error)).size).toBe(util.PROFILE_TEXT_FIELDS.length);
  });

  test("sign-up: an edge tab or line break is refused as at every other door, never trimmed away", async () => {
    test.setTimeout(90_000);
    for (const [field, body, bad] of [
      ["company", "company", "Acme\t"],
      ["first_name", "firstName", "\nAnn"],
      ["country", "country", "GB\r"],
    ]) {
      const email = addr("signup-edge");
      const r = await signUp(email, { [body]: bad });
      refused(r.status, r.body, field);
      expect(byEmail(email), `no account for ${email}`).toBeNull();
    }
    // CONTROL: edge spaces are still trimmed and the sign-up goes through.
    const email = addr("signup-edge-ok");
    const r = await signUp(email, { company: "  Acme  " });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(byEmail(email).company).toBe("Acme");
  });

  test("desk invite: an edge tab is refused, never trimmed away", async () => {
    const { api, csrf } = await apiLogin("superadmin");
    try {
      const bad = addr("desk-edge");
      const r = await api.post("/api/admin/participants/desk-invite", { headers: H(csrf), data: { email: bad, firstName: "Ann", lastName: "Lee\t" } });
      refused(r.status(), await r.json(), "last_name");
      expect(byEmail(bad)).toBeNull();
    } finally { await api.dispose(); }
  });

  test("sign-up: refused by value, nothing created; letters of every script accepted", async () => {
    test.setTimeout(90_000);
    for (const [field, body, bad] of [
      ["first_name", "firstName", `Ann${BEL}`],
      ["last_name", "lastName", `Lee${ESC}[31m`],
      ["company", "company", `Acme${NEL}Corp`],
    ]) {
      const email = addr("signup-bad");
      const r = await signUp(email, { [body]: bad });
      refused(r.status, r.body, field);
      expect(byEmail(email), `no account for ${email}`).toBeNull();
    }
    const email = addr("signup-ok");
    const r = await signUp(email, { firstName: "Müller", lastName: "张伟", company: "محمد Trading" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const u = byEmail(email);
    expect({ f: u.first_name, l: u.last_name, c: u.company }).toEqual({ f: "Müller", l: "张伟", c: "محمد Trading" });
  });

  test("profile save (PUT /api/me): refused by value, the row unchanged; ordinary text saved", async () => {
    test.setTimeout(60_000);
    const { api, csrf } = await signIn(person.email);
    try {
      const before = byId(person.id);
      for (const [field, body, bad] of [
        ["first_name", "firstName", `Mül${BEL}ler`],
        ["title", "title", `Eng${ESC}ineer`],
        ["certificate_given_name", "certificateGivenName", `Ann${NEL}`],
        ["city", "city", `Zürich${BEL}`],
        ["country", "country", `United Kingdom${ESC}`],
      ]) {
        const r = await api.put("/api/me", { headers: H(csrf), data: { [body]: bad } });
        refused(r.status(), await r.json(), field);
        expect(byId(person.id), `${field}: the stored row is unchanged`).toEqual(before);
      }
      const ok = await api.put("/api/me", { headers: H(csrf), data: { city: "Zürich", country: "Österreich", certificateFamilyName: "محمد" } });
      expect(ok.status(), await ok.text()).toBe(200);
      const after = byId(person.id);
      expect({ city: after.city, country: after.country, cf: after.certificate_family_name })
        .toEqual({ city: "Zürich", country: "Österreich", cf: "محمد" });
    } finally { await api.dispose(); }
  });

  test("Users & roles Add user: refused by value, nothing created; ordinary names accepted", async () => {
    const { api, csrf } = await apiLogin("superadmin");
    try {
      const bad = addr("adduser-bad");
      const r = await api.post("/api/admin/users", { headers: H(csrf), data: { email: bad, role: "admin", first_name: "Ann", last_name: `Lee${ESC}` } });
      refused(r.status(), await r.json(), "last_name");
      expect(byEmail(bad)).toBeNull();
      const good = addr("adduser-ok");
      const ok = await api.post("/api/admin/users", { headers: H(csrf), data: { email: good, role: "admin", first_name: "张伟", last_name: "Müller" } });
      expect(ok.status(), await ok.text()).toBe(200);
      const u = byEmail(good);
      expect({ f: u.first_name, l: u.last_name }).toEqual({ f: "张伟", l: "Müller" });
    } finally { await api.dispose(); }
  });

  test("admin profile edit: a regular admin's keep-what-is-there rule does not swallow it, nor does a superadmin's edit", async () => {
    test.setTimeout(60_000);
    const before = byId(person.id);
    expect(before.first_name, "PRECONDITION: a stored first name a regular admin's save keeps").toBeTruthy();
    const reg = await signIn(admin.email);
    try {
      const r = await reg.api.put(`/api/admin/participants/${person.id}`, { headers: H(reg.csrf), data: { firstName: `X${BEL}` } });
      refused(r.status(), await r.json(), "first_name");
      // CONTROL: the same save with ordinary text answers 200 and, by the rule,
      // keeps the stored name: so the 400 above is the control character's.
      const kept = await reg.api.put(`/api/admin/participants/${person.id}`, { headers: H(reg.csrf), data: { firstName: "Somebody" } });
      expect(kept.status(), await kept.text()).toBe(200);
      expect(byId(person.id).first_name).toBe(before.first_name);
    } finally { await reg.api.dispose(); }
    const { api, csrf } = await apiLogin("superadmin");
    try {
      const mid = byId(person.id);
      for (const [field, body, bad] of [["phone", "phone", `+44${NEL}1`], ["certificate_family_name", "certificateFamilyName", `Lee${ESC}`], ["job_function", "jobFunction", `Dev${BEL}`]]) {
        const r = await api.put(`/api/admin/participants/${person.id}`, { headers: H(csrf), data: { [body]: bad } });
        refused(r.status(), await r.json(), field);
        expect(byId(person.id)).toEqual(mid);
      }
      const ok = await api.put(`/api/admin/participants/${person.id}`, { headers: H(csrf), data: { firstName: "محمد", personalTitle: "Dr." } });
      expect(ok.status(), await ok.text()).toBe(200);
      const u = byId(person.id);
      expect({ f: u.first_name, pt: u.personal_title }).toEqual({ f: "محمد", pt: "Dr." });
    } finally { await api.dispose(); }
  });

  test("desk invite: refused by value, nothing created; ordinary names accepted", async () => {
    const { api, csrf } = await apiLogin("superadmin");
    try {
      const bad = addr("desk-bad");
      const r = await api.post("/api/admin/participants/desk-invite", { headers: H(csrf), data: { email: bad, firstName: `Ann${NEL}`, lastName: "Lee" } });
      refused(r.status(), await r.json(), "first_name");
      expect(byEmail(bad)).toBeNull();
      const good = addr("desk-ok");
      const ok = await api.post("/api/admin/participants/desk-invite", { headers: H(csrf), data: { email: good, firstName: "Müller", lastName: "张伟" } });
      expect(ok.status(), await ok.text()).toBe(200);
      expect({ f: byEmail(good).first_name, l: byEmail(good).last_name }).toEqual({ f: "Müller", l: "张伟" });
    } finally { await api.dispose(); }
  });

  test("participant import: the row is skipped and counted, an overwrite leaves the account as it was; the rest imports", async () => {
    const { api, csrf } = await apiLogin("superadmin");
    try {
      const pRow = (over = {}) => {
        const s = stamp();
        return { nickname: `ctl_${s}`, email: `ctl-${s}@company.co`, first_name: "Imp", last_name: "Ort", company: "Acme", title: "Eng",
          country: "US", timezone: "America/New_York", ...over };
      };
      const good = pRow({ first_name: "张伟", last_name: "Müller", company: "محمد" });
      const bad = pRow({ title: `Eng${ESC}[2J` });
      const r = await api.post("/api/admin/import/participants", { headers: H(csrf),
        data: { data: { type: "hackarena-participants", version: 2, participants: [good, bad] }, resolutions: {} } });
      expect(r.status(), await r.text()).toBe(200);
      const d = await r.json();
      expect({ imported: d.imported, control_chars_skipped: d.control_chars_skipped }).toEqual({ imported: 1, control_chars_skipped: 1 });
      expect(byEmail(bad.email)).toBeNull();
      expect({ f: byEmail(good.email).first_name, c: byEmail(good.email).company }).toEqual({ f: "张伟", c: "محمد" });

      // An overwrite of an existing account carrying one: skipped, the row as it was.
      const before = byEmail(good.email);
      const over = { ...good, city: `Town${BEL}` };
      const r2 = await api.post("/api/admin/import/participants", { headers: H(csrf),
        data: { data: { type: "hackarena-participants", version: 2, participants: [over] }, resolutions: { "0": "overwrite" } } });
      expect(r2.status(), await r2.text()).toBe(200);
      const d2 = await r2.json();
      expect({ overwritten: d2.overwritten, control_chars_skipped: d2.control_chars_skipped }).toEqual({ overwritten: 0, control_chars_skipped: 1 });
      expect(byEmail(good.email)).toEqual(before);
    } finally { await api.dispose(); }
  });

  test("the import's skip reaches the operator's toast", async ({ page }) => {
    await page.goto(BASE);
    await page.waitForFunction(() => document.documentElement.dataset.booted === "1");
    const note = (d) => page.evaluate((x) => window._importDropNote(x), d);
    expect(await note({ control_chars_skipped: 2 })).toContain("2 rows were not imported because their names or other profile text hold control characters");
    expect(await note({ control_chars_skipped: 1 })).toContain("1 row was not imported");
    expect(await note({ control_chars_skipped: 0 }), "CONTROL: nothing said when nothing was skipped").toBe("");
  });
});
