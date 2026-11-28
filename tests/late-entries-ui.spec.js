// @ts-check
//
// v8.6.0 — THE BROWSER HALF OF LATE ENTRIES.
//
// The API spec beside this one proves the window opens, the classification holds,
// the board partitions and the certificate says so. It says nothing about whether
// an organiser can FIND the controls on the event in front of them, nor about what
// a late entrant meets on the screens they actually use — and a server capability
// the shipped client cannot reach is not a shipped feature. That gap is exactly
// the shape of the v8.4.1 report ("I don't see the option"), on a form this
// release adds a second section to.
//
// THE CONTROLS THAT KEEP IT HONEST, because every headline assertion here has a
// build that satisfies it for the wrong reason:
//
//   * "the Booth create form shows the Late entries section" is equally satisfied
//     by a build that shows it for every kind, so a Competition and a Program
//     create form must show no such section at all.
//   * "an absent policy key still renders the section" is equally satisfied by a
//     build that renders it unconditionally, so an explicit "never" must still
//     hide it. That pair is the v8.4.1 lesson — `policyOrDefault` fills a missing
//     key with the RESTRICTIVE value, so gating on the merged answer makes the
//     section VANISH during any half-deployed moment and reads as broken.
//   * "the deadline pair is filled and disabled under Automatic" is equally
//     satisfied by a build that disables it always, so unticking must enable it.
//   * "the late entrant sees a countdown" is equally satisfied by a build in which
//     the ended popup never fires for anybody, so an ordinary participant of the
//     SAME event must still meet it.
//   * "the picker shows the event" is equally satisfied by a build that stopped
//     filtering ended events at all, so an ended event with NO late window must
//     still be hidden by the default filter.
const { test, expect } = require("./isolated-test");
const { registerPost } = require("./helpers");
const { freshCtx, getSuperadminPass, PARTICIPANT_PASS, BASE, TEST_DB_PATH, codeLogin } = require("./helpers");
const { adminLogin, awaitCompModel, clickTab, openCompCreateForm, openCompAdvanced } = require("./ui-admin-helpers");

test.use({ baseURL: BASE });

const H = (c) => ({ "x-csrf-token": c, "content-type": "application/json" });
const TAG = `leu${Date.now().toString(36)}`;
let seq = 0;
const uniq = () => `${TAG}${(seq++).toString(36)}`;
const MIN = 60_000;
const CACHE_TTL_MS = 1_000;

async function sa() {
  const { api, csrf: c0 } = await freshCtx();
  const r = await api.post("/api/login", { headers: H(c0), data: { email: "superadmin", password: getSuperadminPass() } });
  expect(r.ok(), `superadmin login: ${r.status()}`).toBeTruthy();
  return { api, csrf: (await (await api.get("/api/csrf-token")).json()).csrfToken };
}

/** Fixture checklist item 2: never borrow a seeded competition. */
async function makeEvent(api, csrf, kind, extra = {}) {
  const r = await api.post("/api/admin/competitions", {
    headers: H(csrf),
    data: {
      name: `${uniq()} ${kind}`, event_kind: kind, timezone: "UTC",
      start_time: new Date(Date.now() - 5 * MIN).toISOString(), duration_minutes: 180,
      self_enroll_enabled: true, ...extra,
    },
  });
  expect(r.ok(), `create ${kind}: ${await r.text()}`).toBeTruthy();
  return (await r.json()).competition;
}

async function makeParticipant(api, csrf, label) {
  const email = `${label}@company.example`;
  const reg = await registerPost(api, "/api/register", {
    headers: H(csrf),
    data: {
      firstName: "Late", lastName: "Probe", nickname: label, email,
      company: "Acme", title: "Engineer", country: "US", timezone: "America/New_York",
      password: PARTICIPANT_PASS, jobFunction: "Software Developer / Engineer", city: "Testville",
    },
  });
  expect(reg.status(), `register ${label}: ${await reg.text()}`).toBe(200);
  const list = await (await api.get("/api/admin/participants?limit=5000")).json();
  const u = (list.participants || []).find(p => p.email === email);
  expect(u, `${label} findable`).toBeTruthy();
  expect((await api.post(`/api/admin/participants/${u.id}/verify`, { headers: H(csrf) })).ok()).toBeTruthy();
  expect((await api.post(`/api/admin/participants/${u.id}/approve`, { headers: H(csrf) })).ok()).toBeTruthy();
  return { id: u.id, email, nickname: label };
}

// The `better-sqlite3` require is LAZY (v7.20.2) — a module-scope binding is taken
// before the per-file recycle deletes and recreates the file.
function rawUpdateComp(id, sql, params = []) {
  const Database = require("better-sqlite3");
  const db = new Database(TEST_DB_PATH);
  try {
    expect(db.prepare(`UPDATE competitions SET ${sql} WHERE id=?`).run(...params, id).changes, "the direct write must land").toBe(1);
  } finally { db.close(); }
}
function rawSetAssignedAt(compId, userId, iso) {
  const Database = require("better-sqlite3");
  const db = new Database(TEST_DB_PATH);
  try {
    expect(db.prepare("UPDATE competition_users SET assigned_at=? WHERE competition_id=? AND user_id=?").run(iso, compId, userId).changes, "the assigned_at write must land").toBe(1);
  } finally { db.close(); }
}

function rawGetComp(id) {
  const Database = require("better-sqlite3");
  const db = new Database(TEST_DB_PATH);
  try { return db.prepare("SELECT * FROM competitions WHERE id=?").get(id); } finally { db.close(); }
}
const schedEndMs = (row) => new Date(row.start_time).getTime() + row.duration_minutes * MIN;

/**
 * End the event in the past and open its late window. See the API spec's note.
 * `endAt` pins the end to an exact instant (v8.12.7 needs one with a seconds
 * field); otherwise it is `agoMinutes` before now.
 */
async function expireEvent(compId, { agoMinutes = 30, duration = 60, endAt = null } = {}) {
  const end = endAt ? new Date(endAt) : new Date(Date.now() - agoMinutes * MIN);
  rawUpdateComp(compId, "start_time=?, duration_minutes=?", [new Date(end.getTime() - duration * MIN).toISOString(), duration]);
  await new Promise(r => setTimeout(r, CACHE_TTL_MS + 250));
  return end;
}

/**
 * Read the admin competition list through the PAGE's own request context.
 *
 * NOT through the `freshCtx` API context these tests build fixtures with. This
 * platform enforces ONE SESSION PER USER, so `adminLogin(page)` — which signs the
 * superadmin in through the browser — invalidates that context's cookie the moment
 * it runs. A read through it afterwards comes back `{error:"Not authenticated"}`,
 * and `.find` on an object throws `(intermediate value).find is not a function`,
 * which names nothing about sessions. The `Array.isArray` guard makes the real
 * cause say itself if this is ever called the wrong way round again.
 */
async function adminListVia(page) {
  const body = await (await page.request.get("/api/admin/competitions")).json();
  expect(Array.isArray(body), `the admin list came back as an array: ${JSON.stringify(body).slice(0, 200)}`).toBe(true);
  return body;
}

// ═══════════════════════════════════════════════════════════════════════════
// The admin form
// ═══════════════════════════════════════════════════════════════════════════
test.describe("v8.6.0 — the admin can find and use the Late entries controls", () => {
  /** Open the editor, waiting for the MODEL rather than the pane (v8.3.33). */
  async function openEditor(page, compId) {
    await clickTab(page, "Events");
    await awaitCompModel(page);
    await page.waitForFunction((id) => (window.S?.adminCompetitionsData || []).some(c => c.id === id), compId, { timeout: 20000 });
    await page.evaluate((id) => window.editCompetition(id), compId);
    await expect(page.locator("#comp-form-overlay")).toBeVisible({ timeout: 15000 });
    // Late entries are under Advanced settings, folded on an edit too (owner's
    // decision, 27 Nov 2026): opened as a person would.
    await openCompAdvanced(page);
  }

  /** Close and WAIT for detachment — a merely-dispatched close stacks overlays. */
  const closeForm = async (page) => {
    const overlay = page.locator("#comp-form-overlay");
    for (let i = 0; i < 5 && (await overlay.count()) > 0; i++) {
      await page.locator('[data-action="overlay-close"][data-overlay-id="comp-form-overlay"]').first()
        .click({ timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(50);
    }
    await expect(overlay, "the editor is closed and nothing is left stacked").toHaveCount(0, { timeout: 10000 });
  };

  /**
   * Save, and answer the edit confirmation.
   *
   * Editing an existing competition raises a confirm dialog ("Update Booth
   * Event") BEFORE the PUT — pre-existing behaviour, and the reason a save that
   * merely clicks the button sends no request at all and times out on an overlay
   * that never closes, naming nothing about the dialog in front of it.
   */
  async function saveAndConfirm(page) {
    // CAPTURE THE SERVER'S OWN ANSWER. Without this a refused PUT surfaces several
    // assertions later as "the column was not written", which is equally true of a
    // click that missed, a dialog that was dismissed and a 400 naming the exact
    // field — three different bugs behind one message.
    const answers = [];
    // THE HANDLER AWAITS THE BODY, so its push lands a tick AFTER the form has
    // closed: returning `answers` straight away handed a caller that asserts on
    // it an EMPTY array whenever the body read lost that race (measured — it
    // read as a PUT that was never sent). Every handler's promise is kept and
    // drained before returning.
    const pending = [];
    const onResp = (rs) => {
      if (rs.request().method() === "PUT" && rs.url().includes("/api/admin/competitions/")) {
        // The REQUEST body as well as the status: "200 but the column did not
        // move" is a client bug and "400 late_entry_deadline_invalid" is a server
        // one, and only what was SENT separates them.
        pending.push((async () => {
          answers.push(`sent=${(rs.request().postData() || "").slice(0, 400)} -> ${rs.status()} ${(await rs.text().catch(() => "")).slice(0, 200)}`);
        })());
      }
    };
    page.on("response", onResp);
    try {
      await page.locator('[data-action="comp-save"]').click();
      const modal = page.locator("#modal-overlay");
      await expect(modal, "the edit confirmation appears").toBeVisible({ timeout: 10000 });
      // BY ID. A generic ".btn:not(.secondary)" matches whichever button the dialog
      // paints first, which on this confirm is Cancel — so the save was silently
      // dismissed and the failure landed on the column rather than on the click.
      await modal.locator("#modal-confirm-btn").click();
      // The server's answer is read AFTER the wait, never baked into an expect
      // message: a message is built when the call is constructed, before the PUT
      // has answered, so it reported "(no PUT was sent)" over a refused save.
      try {
        await expect(page.locator("#comp-form-overlay")).toHaveCount(0, { timeout: 15000 });
      } catch (e) {
        await Promise.all(pending);
        throw new Error(`the save closes the form — server said: ${answers.join(" | ") || "(no PUT was sent)"}\n${e.message}`);
      }
    } finally { page.off("response", onResp); await Promise.all(pending); }
    return answers;
  }

  test("the CREATE form offers it for a Booth Event and for no other kind", async ({ page }) => {
    await adminLogin(page);
    // ── THE SUBJECT ──
    await openCompCreateForm(page, "booth");
    await expect(page.locator("#comp-late-entry"), "a Booth Event's create form has the toggle").toBeVisible();
    // SEEDED FROM THE WIRE. A client literal here makes the server's
    // `=== undefined` branch dead code, which is how every browser-created Booth
    // Event arrived with CxOne on (pre-v8.2.0) and the LinkedIn door open
    // (pre-v8.4.1). Ticked, because the seed for booth is ON.
    await expect(page.locator("#comp-late-entry"), "seeded ON from the kind's default").toBeChecked();
    await expect(page.locator("#comp-late-entry-box"), "and the deadline block is shown with it").toBeVisible();
    await closeForm(page);

    // ── THE CONTROLS. Without these, a build that renders the section for every
    // kind passes the assertion above.
    for (const kind of ["tournament", "program"]) {
      await openCompCreateForm(page, kind);
      await expect(page.locator("#comp-late-entry"), `${kind} has no late-entry section at all`).toHaveCount(0);
      await closeForm(page);
    }
  });

  test("Automatic FILLS and DISABLES the pair; unticking hands it back", async ({ page }) => {
    const { api, csrf } = await sa();
    try {
      const comp = await makeEvent(api, csrf, "booth", { duration_minutes: 60 });
      await adminLogin(page);
      await openEditor(page, comp.id);

      const dEl = page.locator("#comp-late-deadline-date");
      const tEl = page.locator("#comp-late-deadline-time");
      await expect(page.locator("#comp-late-auto"), "unpinned events open on Automatic").toBeChecked();
      // FILLED, never blanked — the `toggleNoDeadline` rule. The value is what the
      // window will actually run to, so an admin reading "automatic" has to be
      // shown WHICH date or the setting is unreviewable.
      await expect(dEl, "the date is filled").not.toHaveValue("");
      await expect(tEl, "and the time").not.toHaveValue("");
      await expect(dEl, "and both are disabled while Automatic is on").toBeDisabled();
      await expect(tEl).toBeDisabled();
      const autoDate = await dEl.inputValue();

      // ── THE CONTROL: "disabled" is equally satisfied by a build that disables
      // them always.
      await page.locator("#comp-late-auto").uncheck();
      await expect(dEl, "unticking hands the pair back").toBeEnabled();
      await expect(tEl).toBeEnabled();
      await expect(dEl, "keeping the value the admin was shown").toHaveValue(autoDate);

      // The note distinguishes the two states rather than saying one thing always.
      const note = () => page.locator("#comp-late-note").innerText();
      await page.locator("#comp-late-deadline-date").fill(autoDate);
      await page.locator("#comp-late-deadline-time").fill("12:00");
      await page.locator("#comp-late-deadline-time").dispatchEvent("change");
      await expect.poll(async () => await note(), { timeout: 5000 }).toContain("will NOT follow");
      await page.locator("#comp-late-auto").check();
      await expect.poll(async () => await note(), { timeout: 5000 }).toContain("48 hours after the event ends");

      await closeForm(page);
    } finally { await api.dispose(); }
  });

  test("v8.6.3 — moving the END TIME moves the Automatic deadline, control AND note", async ({ page }) => {
    // Ask 1. Automatic promises "48 hours after the event ends", and the note has
    // always SAID "move the end time and this moves with it" — it just did not.
    // Nothing recomputed the pair when the schedule changed, so an admin who
    // corrected the duration was left reading the OLD deadline under a sentence
    // claiming it follows.
    const { api, csrf } = await sa();
    try {
      const comp = await makeEvent(api, csrf, "booth", { duration_minutes: 60 });
      await adminLogin(page);
      await openEditor(page, comp.id);

      const dEl = page.locator("#comp-late-deadline-date");
      await expect(page.locator("#comp-late-auto")).toBeChecked();
      await expect(dEl).not.toHaveValue("");
      const before = await dEl.inputValue();
      const noteBefore = await page.locator("#comp-late-note").innerText();

      // Push the end out by three days — enough that the DATE must change, so the
      // assertion cannot pass on a same-day time shift.
      await page.locator("#comp-dur-d").fill("3");
      await page.locator("#comp-dur-d").dispatchEvent("change");

      await expect.poll(async () => await dEl.inputValue(), { timeout: 5000,
        message: "the Automatic deadline follows the end time" }).not.toBe(before);
      await expect.poll(async () => await page.locator("#comp-late-note").innerText(),
        { timeout: 5000, message: "and so does the note beneath it" }).not.toBe(noteBefore);

      // ── THE CONTROL: a build that recomputed on EVERY change would also move a
      // PINNED deadline, which is the one thing "fixed" has to mean.
      await page.locator("#comp-late-auto").uncheck();
      await page.locator("#comp-late-deadline-date").fill("2030-01-02");
      await page.locator("#comp-late-deadline-date").dispatchEvent("change");
      await page.locator("#comp-dur-d").fill("5");
      await page.locator("#comp-dur-d").dispatchEvent("change");
      await expect(dEl, "a PINNED deadline does not follow the end time").toHaveValue("2030-01-02");

      await closeForm(page);
    } finally { await api.dispose(); }
  });

  test("v8.6.3 — the deadline names the event's timezone, and follows it when it changes", async ({ page }) => {
    // Ask 2. The pair is READ BACK with `wallClockToUtc(..., #comp-tz)`, so it
    // means a wall clock in the EVENT's zone — which nothing on screen said. The
    // fill wrote the BROWSER's wall clock into it, so an admin in a different zone
    // saw the wrong time and re-stored a shifted instant on the next save.
    const { api, csrf } = await sa();
    try {
      const comp = await makeEvent(api, csrf, "booth", { duration_minutes: 60 });
      await adminLogin(page);
      await openEditor(page, comp.id);

      const label = page.locator("#comp-late-deadline-label");
      const note = page.locator("#comp-late-note");
      const tzBox = page.locator("#comp-tz");

      // ZONE-AGNOSTIC BY CONSTRUCTION. `competitions` has no stored timezone —
      // the box seeds from the BROWSER and exists to say which zone the wall
      // clocks in this dialog mean — so asserting a literal would pass or fail on
      // the runner's zone rather than on the code (the v8.3.38 trap). The
      // invariant is the RELATIONSHIP: whatever the box holds, the deadline says.
      await expect.poll(async () => await label.innerText(), { timeout: 5000,
        message: "the control names whatever zone the dialog is set to" })
        .toContain(await tzBox.inputValue());

      // Now drive it between two zones that can never share an offset, so the
      // wall-clock assertion below is meaningful on any machine.
      await tzBox.fill("UTC");
      await tzBox.dispatchEvent("change");
      await expect.poll(async () => await label.innerText(), { timeout: 5000 }).toContain("UTC");
      await expect(note, "and so does the note").toContainText("UTC");
      const tEl = page.locator("#comp-late-deadline-time");
      expect(await tEl.inputValue(), "precondition: the pair is filled").not.toBe("");

      await tzBox.fill("Asia/Kolkata");
      await tzBox.dispatchEvent("change");
      await expect.poll(async () => await label.innerText(), { timeout: 5000,
        message: "the label follows the timezone at the top of the dialog" }).toContain("Asia/Kolkata");
      await expect.poll(async () => await note.innerText(), { timeout: 5000,
        message: "and the note does too" }).toContain("Asia/Kolkata");

      // ── THE CONTROL AND THE TEXT MUST AGREE, which is the half a zone LABEL
      // alone cannot give you. The pair is read back in the dialog's zone, so the
      // note has to be FORMATTED in that zone too — it used to render in the
      // BROWSER's, so once the two differ the sentence and the field beneath it
      // described different clock times while both claimed the same deadline.
      // +05:30 is never equal to UTC, so on a UTC runner this cannot pass by
      // coincidence.
      //
      // The expectation is DERIVED in the page from the control's own value, not
      // restated as a literal: `<input type=time>` is always 24-hour while the
      // note uses the browser's locale, so a substring match on "09:30" fails on
      // a 12-hour locale against perfectly correct output.
      await expect.poll(async () => {
        const want = await page.evaluate(() => {
          const d = document.getElementById("comp-late-deadline-date").value;
          const t = document.getElementById("comp-late-deadline-time").value;
          const tz = document.getElementById("comp-tz").value;
          const inst = window.wallClockToUtc(d, t, tz);
          return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short", timeZone: tz }).format(inst);
        });
        return (await note.innerText()).includes(want);
      }, { timeout: 5000, message: "the note states the deadline in the dialog's zone, matching the control" }).toBe(true);

      await closeForm(page);
    } finally { await api.dispose(); }
  });

  test("v8.6.3 — the note states the SELECTED deadline, in bold", async ({ page }) => {
    // Ask 3. The two deadline inputs had NO change handler, so typing a date left
    // the sentence beneath describing whatever was there before it.
    const { api, csrf } = await sa();
    try {
      const comp = await makeEvent(api, csrf, "booth", { duration_minutes: 60 });
      await adminLogin(page);
      await openEditor(page, comp.id);

      await page.locator("#comp-late-auto").uncheck();
      await page.locator("#comp-late-deadline-date").fill("2031-03-04");
      await page.locator("#comp-late-deadline-time").fill("09:30");
      await page.locator("#comp-late-deadline-time").dispatchEvent("change");

      const note = page.locator("#comp-late-note");
      await expect.poll(async () => await note.innerText(), { timeout: 5000,
        message: "the note reports the date the admin actually typed" }).toContain("2031");
      // BOLD, and it is the DATE that is bold rather than the whole sentence —
      // the date is the answer the block exists to give.
      const strong = note.locator("strong");
      await expect(strong, "the deadline is bold").toHaveCount(1);
      await expect(strong).toContainText("2031");

      // …and it keeps following a further edit, so this is a live reflection of the
      // selection rather than a one-shot render.
      await page.locator("#comp-late-deadline-date").fill("2032-05-06");
      await page.locator("#comp-late-deadline-date").dispatchEvent("change");
      await expect.poll(async () => await note.innerText(), { timeout: 5000 }).toContain("2032");

      await closeForm(page);
    } finally { await api.dispose(); }
  });

  test("turning the feature OFF hides the deadline block", async ({ page }) => {
    const { api, csrf } = await sa();
    try {
      const comp = await makeEvent(api, csrf, "booth");
      await adminLogin(page);
      await openEditor(page, comp.id);
      await expect(page.locator("#comp-late-entry-box"), "shown while the feature is on").toBeVisible();
      await page.locator("#comp-late-entry").uncheck();
      await expect(page.locator("#comp-late-entry-box"), "hidden when it is off").toBeHidden();
      await page.locator("#comp-late-entry").check();
      await expect(page.locator("#comp-late-entry-box"), "and back when it is on again").toBeVisible();
      await closeForm(page);
    } finally { await api.dispose(); }
  });

  test("a real Save round-trips through the SERVER, both the toggle and a pinned date", async ({ page }) => {
    const { api, csrf } = await sa();
    try {
      const comp = await makeEvent(api, csrf, "booth", { duration_minutes: 60 });
      await adminLogin(page);
      await openEditor(page, comp.id);

      await page.locator("#comp-late-auto").uncheck();
      const d = await page.locator("#comp-late-deadline-date").inputValue();
      await page.locator("#comp-late-deadline-time").fill("09:30");
      await page.locator("#comp-late-deadline-time").dispatchEvent("change");
      // The zone the form converts through, read from the form itself. What is
      // typed is a WALL CLOCK and what is stored is UTC, so the two differ by the
      // offset — asserting the ISO's date prefix against the typed date is a
      // timezone bug in the test that reads as one in the product.
      const tz = await page.locator("#comp-tz").inputValue();
      const answers = await saveAndConfirm(page);

      // Read back off the SERVER, never off the model the form just wrote: the
      // point of the assertion is that the value reached the column.
      await expect.poll(async () => {
        const row = (await adminListVia(page)).find(c => c.id === comp.id);
        return row && row.late_entry_deadline_at ? "pinned" : "not pinned";
      }, { timeout: 15000, message: `the PUT should have pinned it — server said: ${answers.join(" | ") || "(no PUT)"}` }).toBe("pinned");
      const row = (await adminListVia(page)).find(c => c.id === comp.id);
      expect(row.late_entry_enabled, "the toggle is still on").toBeTruthy();
      // ROUND TRIP: render the stored instant back in the form's own zone and
      // compare wall clock with wall clock.
      const back = new Intl.DateTimeFormat("en-CA", {
        timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", hour12: false,
      }).formatToParts(new Date(row.late_entry_deadline_at))
        .reduce((a, p) => (a[p.type] = p.value, a), {});
      expect(`${back.year}-${back.month}-${back.day}`, "the pinned date is the one typed").toBe(d);
      expect(`${back.hour}:${back.minute}`, "and so is the time").toBe("09:30");

      // Turning it OFF round-trips too, which is the other direction.
      await openEditor(page, comp.id);
      await page.locator("#comp-late-entry").uncheck();
      const answers2 = await saveAndConfirm(page);
      await expect.poll(async () => {
        const r2 = (await adminListVia(page)).find(c => c.id === comp.id);
        return !!(r2 && r2.late_entry_enabled);
      }, { timeout: 15000, message: `turning it off should have reached the column — server said: ${answers2.join(" | ") || "(no PUT)"}` }).toBe(false);
    } finally { await api.dispose(); }
  });

  test("ABSENT IS NOT FALSE — a policy payload with no late_entry key still renders the section", async ({ page }) => {
    const { api, csrf } = await sa();
    try {
      const comp = await makeEvent(api, csrf, "booth");
      await adminLogin(page);
      await clickTab(page, "Events");
      await awaitCompModel(page);
      await page.waitForFunction((id) => (window.S?.adminCompetitionsData || []).some(c => c.id === id), comp.id, { timeout: 20000 });

      // ── THE REGRESSION LOCK. `policyOrDefault` fills a missing key with the
      // RESTRICTIVE value, so gating the section on the MERGED answer makes it
      // vanish during any half-deployed moment — a server one commit behind a
      // reloaded SPA, a module served from cache. That reads as a broken feature
      // and gets reported as one (v8.4.1, on this very form).
      await page.evaluate((id) => {
        const c = (window.S.adminCompetitionsData || []).find(x => x.id === id);
        delete c.policy.late_entry;
      }, comp.id);
      await page.evaluate((id) => window.editCompetition(id), comp.id);
      await expect(page.locator("#comp-form-overlay")).toBeVisible({ timeout: 15000 });
      await openCompAdvanced(page);
      await expect(page.locator("#comp-late-entry"),
        "an ABSENT key falls back to the kind and still renders the section").toBeVisible();
      await closeForm(page);

      // ── THE CONTROL: an explicit "never" must still hide it, or the fallback is
      // just "render it always".
      await page.evaluate((id) => {
        const c = (window.S.adminCompetitionsData || []).find(x => x.id === id);
        c.policy.late_entry = "never";
      }, comp.id);
      await page.evaluate((id) => window.editCompetition(id), comp.id);
      await expect(page.locator("#comp-form-overlay")).toBeVisible({ timeout: 15000 });
      await expect(page.locator("#comp-late-entry"),
        "an explicit refusal is obeyed").toHaveCount(0);
      await closeForm(page);
    } finally { await api.dispose(); }
  });

  // ═════════════════════════════════════════════════════════════════════════
  // v8.12.7 — closing late entries right after End Now, from the EDITOR.
  //
  // The API spec pins the server's rule (the deadline is judged against the
  // effective end the save leaves, not the scheduled end). These arms pin the
  // three client halves the rule depends on, each of which could be wrong while
  // the server is right: the editor must send back a stored pin VERBATIM rather
  // than the minute its date/time pair shows (a sub-minute pin rounded down can
  // fall before the end and be refused), it must warn of a revival only when
  // the save MOVES the schedule (End Now rounds the elapsed time UP to a minute,
  // so for up to a minute afterwards the stored scheduled end still lies ahead
  // and every save used to say "will become live again"), and the End Now
  // dialog must say that ending a late-entry event OPENS its window rather than
  // that no further submissions will be accepted.
  //
  // Every fixture is written through the API BEFORE `adminLogin(page)`: the
  // browser sign-in ends the API context's session (one session per user).
  // ═════════════════════════════════════════════════════════════════════════
  test.describe("v8.12.7 — closing late entries right after End Now", () => {
    /** A Booth Event started at `start`, ended through the real End Now route. */
    async function endNowBooth(api, csrf, start) {
      const comp = await makeEvent(api, csrf, "booth", { start_time: new Date(start).toISOString(), duration_minutes: 600 });
      const en = await api.post(`/api/admin/competitions/${comp.id}/end-now`, { headers: H(csrf) });
      expect(en.ok(), `end-now: ${await en.text()}`).toBeTruthy();
      const row = rawGetComp(comp.id);
      expect(row.ended_manually, "End Now recorded a MANUAL end").toBe(1);
      expect(new Date(row.ended_at).getTime(),
        "PRECONDITION: ceil rounding left the stored scheduled end AFTER the moment the event ended")
        .toBeLessThan(schedEndMs(row));
      return { comp, row };
    }

    async function pinVia(api, csrf, compId, iso) {
      const r = await api.put(`/api/admin/competitions/${compId}`, { headers: H(csrf), data: { late_entry_deadline_at: iso } });
      expect(r.status(), `pinning the deadline by API: ${await r.text()}`).toBe(200);
      const stored = rawGetComp(compId).late_entry_deadline_at;
      expect(new Date(stored).getTime(), "PRECONDITION: the pin reached the column").toBe(new Date(iso).getTime());
      return stored;
    }

    /** A wall clock in `tz`, in the shape the form's date/time pair takes. */
    function wallClock(tz, ms) {
      const p = new Intl.DateTimeFormat("en-CA", {
        timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", hourCycle: "h23",
      }).formatToParts(new Date(ms)).reduce((a, x) => (a[x.type] = x.value, a), {});
      return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
    }

    /**
     * Every competition PUT body the page sends, IN FULL. `saveAndConfirm`'s own
     * record truncates the body, and the deadline key can sit past the cut — an
     * assertion over a truncated body would say "not echoed" about a body that
     * echoed it.
     */
    function capturePuts(page) {
      const bodies = [];
      const on = (rq) => {
        if (rq.method() === "PUT" && /\/api\/admin\/competitions\/[^/]+$/.test(new URL(rq.url()).pathname)) bodies.push(rq.postData() || "");
      };
      page.on("request", on);
      return { bodies, stop: () => page.off("request", on) };
    }

    /** Click Save, read the confirmation, and CANCEL it — nothing is written. */
    async function confirmTextThenCancel(page) {
      await page.locator('[data-action="comp-save"]').click();
      const modal = page.locator("#modal-overlay");
      await expect(modal, "the edit confirmation appears").toBeVisible({ timeout: 10000 });
      const text = await page.locator("#modal-body").innerText();
      const at = Date.now();
      await modal.locator("#modal-cancel-btn").click();
      await expect(modal, "the confirmation is dismissed").toBeHidden({ timeout: 10000 });
      return { text, at };
    }

    async function setAttemptCap(page, n) {
      const cap = page.locator("#comp-attempt-cap");
      await cap.fill(String(n));
      await cap.dispatchEvent("change");
    }

    test("arm 8 — typing the scheduled end's own minute after End Now is accepted", async ({ page }) => {
      const { api, csrf } = await sa();
      let comp, row;
      try {
        // Started five whole minutes ago, so End Now stores a whole-minute duration
        // and the stored scheduled end M is itself a whole minute the form can type.
        ({ comp, row } = await endNowBooth(api, csrf, Math.floor(Date.now() / MIN) * MIN - 5 * MIN));
      } finally { await api.dispose(); }
      const M = schedEndMs(row);
      expect(M % MIN, "PRECONDITION: the scheduled end is a whole minute").toBe(0);
      expect(M, "PRECONDITION: M lies after the moment the event ended").toBeGreaterThan(new Date(row.ended_at).getTime());
      expect(row.late_entry_deadline_at, "PRECONDITION: the deadline starts automatic").toBeNull();

      await adminLogin(page);
      await openEditor(page, comp.id);
      await page.locator("#comp-late-auto").uncheck();
      const tz = await page.locator("#comp-tz").inputValue();
      const w = wallClock(tz, M);
      await page.locator("#comp-late-deadline-date").fill(w.date);
      await page.locator("#comp-late-deadline-date").dispatchEvent("change");
      await page.locator("#comp-late-deadline-time").fill(w.time);
      await page.locator("#comp-late-deadline-time").dispatchEvent("change");
      // M is the stored SCHEDULED end: judged against that (the defect) it is not
      // after the base and is refused; judged against the effective end End Now
      // left, it is after it. Deterministic — the answer does not depend on when
      // the save lands.
      const answers = await saveAndConfirm(page);
      expect(answers.join(" | "), "the PUT was accepted").toMatch(/ -> 200 /);
      const stored = rawGetComp(comp.id).late_entry_deadline_at;
      expect(stored && new Date(stored).getTime(), `the pin is the minute typed — server said: ${answers.join(" | ")}`).toBe(M);
    });

    test("arm 9 — a save that does not move the schedule warns of no revival", async ({ page }) => {
      const { api, csrf } = await sa();
      let comp, row;
      try { ({ comp, row } = await endNowBooth(api, csrf, Date.now() - 61_000)); }
      finally { await api.dispose(); }
      const schedEnd = schedEndMs(row);

      await adminLogin(page);
      await openEditor(page, comp.id);
      await setAttemptCap(page, 3);
      const plain = await confirmTextThenCancel(page);
      // The false warning could only appear while the stored scheduled end still
      // lay ahead; a confirm raised after it passed proves nothing about the gate.
      expect(plain.at, "PRECONDITION: the confirm was raised while the stored scheduled end still lay ahead")
        .toBeLessThan(schedEnd);
      expect(plain.text, "a save that moves nothing revives nothing, so it must not say it will").not.toContain("Revival warning");
      expect(plain.text).not.toContain("will become live again");

      // CONTROL, same event and same form: a save that DOES move the schedule
      // still warns — or the arm above is satisfied by a build that never warns.
      const h = page.locator("#comp-dur-h");
      await h.fill(String((parseInt(await h.inputValue(), 10) || 0) + 1));
      await h.dispatchEvent("change");
      const moved = await confirmTextThenCancel(page);
      expect(moved.text, "CONTROL: extending the duration still names the revival").toContain("Revival warning");
      expect(moved.text).toContain("was manually ended and will become live again");
      await closeForm(page);
      expect(rawGetComp(comp.id).ended_at, "nothing was saved — the event is still ended").toBe(row.ended_at);
    });

    test("arm 10 — a sub-minute pin on a time-expired event is echoed verbatim", async ({ page }) => {
      const { api, csrf } = await sa();
      let comp, stored, end;
      try {
        comp = await makeEvent(api, csrf, "booth");
        // An end with a seconds field, and a pin 30.5 s after it: the minute the
        // form SHOWS for that pin is before the end, so a rounded echo is refused.
        end = await expireEvent(comp.id, { endAt: Math.floor(Date.now() / MIN) * MIN - 25 * MIN + 5_000 });
        stored = await pinVia(api, csrf, comp.id, new Date(end.getTime() + 30_500).toISOString());
      } finally { await api.dispose(); }
      expect(Math.floor(new Date(stored).getTime() / MIN) * MIN,
        "PRECONDITION: the minute the form shows for the pin is BEFORE the end").toBeLessThan(end.getTime());

      await adminLogin(page);
      await openEditor(page, comp.id);
      await expect(page.locator("#comp-late-auto"), "PRECONDITION: the editor opens on the pinned deadline").not.toBeChecked();
      await setAttemptCap(page, 3);
      const puts = capturePuts(page);
      let answers;
      try { answers = await saveAndConfirm(page); } finally { puts.stop(); }
      expect(answers.join(" | ")).toMatch(/ -> 200 /);
      expect(puts.bodies.length, "one PUT was sent").toBe(1);
      expect(JSON.parse(puts.bodies[0]).late_entry_deadline_at, "the stored pin went back VERBATIM").toBe(stored);
      const after = rawGetComp(comp.id);
      expect(after.late_entry_deadline_at, "the column is byte-identical").toBe(stored);
      expect(after.attempt_cap, "and the field actually edited was written").toBe(3);
    });

    test("arm 11 — a pin set just after End Now survives an unrelated save", async ({ page }) => {
      const { api, csrf } = await sa();
      let comp, row, stored;
      try {
        ({ comp, row } = await endNowBooth(api, csrf, Date.now() - 61_000));
        // Ten seconds after the end, with milliseconds a minute field cannot
        // show. End Now lands on a whole second in 1 run of 1000, and a pin
        // copied from it would carry none: move it off the second instead.
        const pinMs = new Date(row.ended_at).getTime() + 10_000;
        stored = await pinVia(api, csrf, comp.id, new Date(pinMs % 1000 ? pinMs : pinMs + 437).toISOString());
      } finally { await api.dispose(); }
      expect(new Date(stored).getTime() % 1000, "PRECONDITION: the pin carries milliseconds a minute field cannot show").not.toBe(0);

      await adminLogin(page);
      await openEditor(page, comp.id);
      await setAttemptCap(page, 4);
      const puts = capturePuts(page);
      let answers;
      try { answers = await saveAndConfirm(page); } finally { puts.stop(); }
      expect(answers.join(" | ")).toMatch(/ -> 200 /);
      expect(JSON.parse(puts.bodies[0]).late_entry_deadline_at, "the stored pin went back VERBATIM").toBe(stored);
      const after = rawGetComp(comp.id);
      expect(after.late_entry_deadline_at, "the pin is unchanged").toBe(stored);
      expect(after.attempt_cap).toBe(4);
      expect(after.ended_at, "and the event was not revived").toBe(row.ended_at);
    });

    test("arm 12 — the End Now dialog says ending a late-entry event opens its window", async ({ page }) => {
      const { api, csrf } = await sa();
      let auto, pinned, off, tourn, pin;
      try {
        auto = await makeEvent(api, csrf, "booth");
        pinned = await makeEvent(api, csrf, "booth");
        pin = await pinVia(api, csrf, pinned.id, new Date(schedEndMs(rawGetComp(pinned.id)) + 3 * 60 * MIN).toISOString());
        off = await makeEvent(api, csrf, "booth", { late_entry_enabled: false });
        tourn = await makeEvent(api, csrf, "tournament");
      } finally { await api.dispose(); }
      expect(rawGetComp(auto.id).late_entry_enabled, "PRECONDITION: a Booth Event takes late entries by default").toBe(1);
      expect(rawGetComp(off.id).late_entry_enabled, "PRECONDITION: the control booth has them off").toBe(0);

      await adminLogin(page);
      await clickTab(page, "Events");
      await awaitCompModel(page);
      const ids = [auto.id, pinned.id, off.id, tourn.id];
      await page.waitForFunction((xs) => xs.every(id => (window.S?.adminCompetitionsData || []).some(c => c.id === id)), ids, { timeout: 20000 });
      const dialogText = async (id) => {
        // Fire and forget: `endNow` awaits the dialog, so awaiting it here would
        // wait for an answer nobody gives.
        await page.evaluate((x) => { window.endNow(x); }, id);
        const modal = page.locator("#modal-overlay");
        await expect(modal).toBeVisible({ timeout: 10000 });
        const text = await page.locator("#modal-body").innerText();
        await modal.locator("#modal-cancel-btn").click();
        await expect(modal).toBeHidden({ timeout: 10000 });
        return text;
      };

      const tAuto = await dialogText(auto.id);
      expect(tAuto, "a late-entry booth: ending it opens the window").toContain("late entrants keep playing until 48 hours after it ends");
      expect(tAuto).not.toContain("no further submissions");
      // v8.12.8 — the way to close the window early is the organiser's own
      // "Close late entries now", not a superadmin editing the deadline.
      expect(tAuto, "the early-close remedy names the new control").toContain("Close late entries now");
      expect(tAuto, "…and no longer sends the admin to a superadmin").not.toContain("a superadmin sets");

      const tPinned = await dialogText(pinned.id);
      const pinText = await page.evaluate((iso) => window.fmtDt(iso, "long", { withZone: true }), pin);
      expect(pinText, "PRECONDITION: the page can format the pin").toBeTruthy();
      expect(tPinned, "a pinned deadline is named").toContain(`late entrants keep playing until ${pinText}`);
      expect(tPinned).not.toContain("no further submissions");
      expect(tPinned).toContain("Close late entries now");
      expect(tPinned).not.toContain("a superadmin sets");

      for (const [id, why] of [[off.id, "a booth with late entries off"], [tourn.id, "a Competition"]]) {
        const t = await dialogText(id);
        expect(t, `CONTROL: ${why} keeps the original sentence`).toContain("no further submissions will be accepted");
        expect(t).not.toMatch(/late entr/i);
      }
      for (const id of ids) expect(rawGetComp(id).ended_at, "nothing was ended — every dialog was cancelled").toBeNull();
    });

    test("arm 13 — an ended SESSION left untouched warns of no revival", async ({ page }) => {
      const { api, csrf } = await sa();
      let comp, ts, tsRow;
      try {
        comp = await makeEvent(api, csrf, "tournament", { start_time: new Date(Date.now() + 24 * 60 * MIN).toISOString() });
        const cr = await api.post(`/api/admin/competitions/${comp.id}/timeslots`, {
          headers: H(csrf), data: { name: `${uniq()} s1`, start_time: new Date(Date.now() - 61_000).toISOString(), duration_minutes: 600 },
        });
        expect(cr.ok(), `create session: ${await cr.text()}`).toBeTruthy();
        ts = (await cr.json()).timeslot;
        expect(ts && ts.id, "PRECONDITION: the session was created").toBeTruthy();
        // A second, UPCOMING session: the editor refuses a multi-session save with
        // fewer than two, before any confirmation is raised.
        const cr2 = await api.post(`/api/admin/competitions/${comp.id}/timeslots`, {
          headers: H(csrf), data: { name: `${uniq()} s2`, start_time: new Date(Math.floor(Date.now() / MIN) * MIN + 24 * 60 * MIN).toISOString(), duration_minutes: 60 },
        });
        expect(cr2.ok(), `create second session: ${await cr2.text()}`).toBeTruthy();
        const en = await api.post(`/api/admin/competitions/${comp.id}/timeslots/${ts.id}/end-now`, { headers: H(csrf) });
        expect(en.ok(), `session end-now: ${await en.text()}`).toBeTruthy();
      } finally { await api.dispose(); }
      {
        const Database = require("better-sqlite3");
        const db = new Database(TEST_DB_PATH);
        try { tsRow = db.prepare("SELECT * FROM competition_timeslots WHERE id=?").get(ts.id); } finally { db.close(); }
      }
      expect(tsRow.ended_manually, "End Now recorded a MANUAL session end").toBe(1);
      const schedEnd = schedEndMs(tsRow);
      expect(new Date(tsRow.ended_at).getTime(), "PRECONDITION: the session's stored scheduled end lies after its end")
        .toBeLessThan(schedEnd);

      await adminLogin(page);
      await openEditor(page, comp.id);
      const row = page.locator("#comp-form-overlay").locator(`[data-ts-id="${ts.id}"]`);
      await expect(row, "PRECONDITION: the editor renders the session's row").toHaveCount(1);
      await setAttemptCap(page, 3);
      const plain = await confirmTextThenCancel(page);
      expect(plain.at, "PRECONDITION: the confirm was raised while the session's scheduled end still lay ahead")
        .toBeLessThan(schedEnd);
      expect(plain.text, "an untouched ended session revives nothing").not.toContain("Revival warning");

      // CONTROL: extending that session still names its revival.
      const h = row.locator(".ts-dur-h");
      await h.fill(String((parseInt(await h.inputValue(), 10) || 0) + 1));
      await h.dispatchEvent("change");
      const moved = await confirmTextThenCancel(page);
      expect(moved.text, "CONTROL: extending the session names the revival").toContain("was manually ended and will become live again");
      await closeForm(page);
    });

    // THE WARNING MUST PREDICT WHAT THE SERVER DOES. An auto-ended event (ended_at
    // set, not a manual end) STAYS ended on an extend only where the server's gate
    // re-asks "has everybody finished?" — the event can auto-end on all-solved AND
    // its join link is closed. Everywhere else it revives, and the confirm used to
    // say "Saving keeps it ended" over a save that then revived it. One event per
    // clause, so each clause is witnessed on its own (a legacy Booth Event with its
    // link CLOSED is revived by its column alone; a tournament with its column ON
    // by its open link alone), plus the case that really does stay ended as the
    // control — without it "the warning names the revival" is satisfied by a build
    // that retired the kept-ended wording.
    test("arm 14 — an auto-ended event is warned it STAYS ended only where the server keeps it so", async ({ page }) => {
      /** Plant the legacy auto-ended shape: `ended_at` 2 min ago, not a manual end. */
      const autoEnd = async (compId) => {
        rawUpdateComp(compId, "ended_at=?, ended_manually=0", [new Date(Date.now() - 2 * MIN - 7_000).toISOString()]);
        await new Promise(r => setTimeout(r, CACHE_TTL_MS + 250));
        const row = rawGetComp(compId);
        expect(schedEndMs(row), "PRECONDITION: the schedule still runs, so an extend puts the end ahead").toBeGreaterThan(Date.now() + 30 * MIN);
        return row;
      };
      const { api, csrf } = await sa();
      let booth, tOpen, tClosed, prog, rows;
      try {
        booth = await makeEvent(api, csrf, "booth", { self_enroll_enabled: false });
        tOpen = await makeEvent(api, csrf, "tournament", { self_enroll_enabled: true });
        tClosed = await makeEvent(api, csrf, "tournament", { self_enroll_enabled: false });
        // A Program is the deadline-shaped branch of the same warning.
        const pStart = Date.now() - 5 * MIN;
        prog = await makeEvent(api, csrf, "program", { start_time: new Date(pStart).toISOString(), deadline_at: new Date(pStart + 180 * MIN).toISOString() });
        rows = {};
        for (const c of [booth, tOpen, tClosed, prog]) rows[c.id] = await autoEnd(c.id);
      } finally { await api.dispose(); }
      // The two columns each case turns on, as stored — so each case really is the
      // one it claims to be.
      expect([rows[booth.id].auto_end_on_all_solved, rows[booth.id].self_enroll_enabled], "PRECONDITION: booth — column off, link closed").toEqual([0, 0]);
      expect([rows[tOpen.id].auto_end_on_all_solved, rows[tOpen.id].self_enroll_enabled], "PRECONDITION: tournament — column on, link OPEN").toEqual([1, 1]);
      expect([rows[tClosed.id].auto_end_on_all_solved, rows[tClosed.id].self_enroll_enabled], "PRECONDITION: tournament — column on, link closed").toEqual([1, 0]);
      expect(rows[prog.id].auto_end_on_all_solved, "PRECONDITION: a Program's column is off").toBe(0);

      await adminLogin(page);
      /** Open the editor, extend by an hour, read the confirm, cancel. */
      const extendAndRead = async (compId) => {
        await openEditor(page, compId);
        const wire = await page.evaluate((id) => window.S.adminCompetitionsData.find(c => c.id === id), compId);
        expect(wire.status, "PRECONDITION: the row reads ended").toBe("ended");
        expect([wire.auto_end_on_all_solved, wire.self_enroll_enabled], "PRECONDITION: both columns ride the admin list row")
          .toEqual([rows[compId].auto_end_on_all_solved, rows[compId].self_enroll_enabled]);
        const h = page.locator("#comp-dur-h");
        await h.fill(String((parseInt(await h.inputValue(), 10) || 0) + 1));
        await h.dispatchEvent("change");
        const { text } = await confirmTextThenCancel(page);
        await closeForm(page);
        return text;
      };

      for (const [c, why] of [[booth, "a legacy Booth Event (it never auto-ends on all-solved)"], [tOpen, "an event whose join link is open"]]) {
        const text = await extendAndRead(c.id);
        expect(text, `${why}: the extend revives it, and the confirm says so`).toContain("auto-ended before its scheduled time and will become live again");
        expect(text, `${why}: it must not claim the save keeps it ended`).not.toContain("keeps it ended");
      }

      const kept = await extendAndRead(tClosed.id);
      expect(kept, "CONTROL: auto-ended on all-solved with the link closed — the server re-checks, so the confirm says it stays ended")
        .toContain("Saving keeps it ended");
      expect(kept).not.toContain("will become live again");

      // The deadline-shaped branch: a Program moving its deadline forward.
      await openEditor(page, prog.id);
      const dEl = page.locator("#comp-deadline-date");
      const d0 = await dEl.inputValue();
      expect(d0, "PRECONDITION: the Program's deadline is shown").toMatch(/^\d{4}-\d{2}-\d{2}$/);
      await dEl.fill(new Date(Date.parse(`${d0}T00:00:00Z`) + 24 * 60 * MIN).toISOString().slice(0, 10));
      await dEl.dispatchEvent("change");
      const pText = (await confirmTextThenCancel(page)).text;
      await closeForm(page);
      expect(pText, "a Program moving its deadline forward: it revives, and the confirm says so").toContain("auto-ended before its deadline and will become live again");
      expect(pText).not.toContain("keeps it ended");

      // THE SERVER AGREES — the copy is only worth something if it is true.
      const s2 = await sa();
      try {
        for (const c of [booth, tOpen]) {
          const r = await s2.api.put(`/api/admin/competitions/${c.id}`, {
            headers: H(s2.csrf), data: { duration_minutes: rows[c.id].duration_minutes + 60 },
          });
          expect(r.status(), `extend by API: ${await r.text()}`).toBe(200);
          expect(rawGetComp(c.id).ended_at, "the server revived it, as the confirm said").toBeNull();
        }
      } finally { await s2.api.dispose(); }
    });

    // The session twin of arm 14: routes/sessions.js asks the COMPETITION's two
    // columns before it keeps an auto-ended session ended.
    test("arm 16 — an auto-ended SESSION is warned it stays ended only while its event's join link is closed", async ({ page }) => {
      const { api, csrf } = await sa();
      const made = [];
      try {
        for (const selfEnroll of [true, false]) {
          const comp = await makeEvent(api, csrf, "tournament", { self_enroll_enabled: selfEnroll, start_time: new Date(Date.now() + 24 * 60 * MIN).toISOString() });
          const cr = await api.post(`/api/admin/competitions/${comp.id}/timeslots`, {
            headers: H(csrf), data: { name: `${uniq()} s1`, start_time: new Date(Date.now() - 61_000).toISOString(), duration_minutes: 600 },
          });
          expect(cr.ok(), `create session: ${await cr.text()}`).toBeTruthy();
          const ts = (await cr.json()).timeslot;
          // A second, upcoming session — the editor refuses a multi-session save with fewer.
          const cr2 = await api.post(`/api/admin/competitions/${comp.id}/timeslots`, {
            headers: H(csrf), data: { name: `${uniq()} s2`, start_time: new Date(Math.floor(Date.now() / MIN) * MIN + 24 * 60 * MIN).toISOString(), duration_minutes: 60 },
          });
          expect(cr2.ok(), `create second session: ${await cr2.text()}`).toBeTruthy();
          made.push({ comp, ts, selfEnroll });
        }
      } finally { await api.dispose(); }
      {
        const Database = require("better-sqlite3");
        const db = new Database(TEST_DB_PATH);
        try {
          for (const m of made) {
            expect(db.prepare("UPDATE competition_timeslots SET ended_at=?, ended_manually=0 WHERE id=?")
              .run(new Date(Date.now() - 30_000).toISOString(), m.ts.id).changes, "the session auto-ends").toBe(1);
            const c = db.prepare("SELECT auto_end_on_all_solved, self_enroll_enabled FROM competitions WHERE id=?").get(m.comp.id);
            expect([c.auto_end_on_all_solved, c.self_enroll_enabled], "PRECONDITION: the column is on; the link is as built")
              .toEqual([1, m.selfEnroll ? 1 : 0]);
          }
        } finally { db.close(); }
      }
      await new Promise(r => setTimeout(r, CACHE_TTL_MS + 250));

      await adminLogin(page);
      const texts = {};
      for (const m of made) {
        await openEditor(page, m.comp.id);
        const row = page.locator("#comp-form-overlay").locator(`[data-ts-id="${m.ts.id}"]`);
        await expect(row, "PRECONDITION: the editor renders the session's row").toHaveCount(1);
        const h = row.locator(".ts-dur-h");
        await h.fill(String((parseInt(await h.inputValue(), 10) || 0) + 1));
        await h.dispatchEvent("change");
        texts[m.selfEnroll] = (await confirmTextThenCancel(page)).text;
        await closeForm(page);
      }
      expect(texts[true], "link open: the extend revives the session, and the confirm says so")
        .toContain("auto-ended before its scheduled time and will become live again");
      expect(texts[true]).not.toContain("keeps it ended");
      expect(texts[false], "CONTROL: link closed — the server re-checks, so it stays ended").toContain("Saving keeps it ended");

      // THE SERVER AGREES for the open-link session.
      const open = made.find(m => m.selfEnroll);
      const s2 = await sa();
      try {
        const r = await s2.api.put(`/api/admin/competitions/${open.comp.id}/timeslots/${open.ts.id}`, {
          headers: H(s2.csrf), data: { duration_minutes: 660 },
        });
        expect(r.status(), `extend the session by API: ${await r.text()}`).toBe(200);
      } finally { await s2.api.dispose(); }
      const Database = require("better-sqlite3");
      const db = new Database(TEST_DB_PATH);
      try {
        expect(db.prepare("SELECT ended_at FROM competition_timeslots WHERE id=?").get(open.ts.id).ended_at,
          "the server revived the session, as the confirm said").toBeNull();
      } finally { db.close(); }
    });

    // THE ECHO IS DECIDED ON THE PAIR'S TEXT. On a fall-back night one wall clock
    // names two instants and the read-back takes the FIRST, so a pin in the SECOND
    // 01:30 read back an hour early; compared as an instant it looked edited, and
    // an unrelated save sent the read-back and rewound the pin an hour.
    test.describe("in the repeated hour of a fall-back night", () => {
      test.use({ timezoneId: "America/New_York" });
      const TZ = "America/New_York";

      /** The second 01:30:15 (EST, 06:30:15Z) of the next first-Sunday-of-November far enough ahead. */
      function secondOneThirty() {
        for (let y = new Date().getUTCFullYear(); ; y++) {
          let day = 1;
          while (new Date(Date.UTC(y, 10, day)).getUTCDay() !== 0) day++;
          const ms = Date.UTC(y, 10, day, 6, 30, 15);
          if (ms > Date.now() + 4 * 24 * 60 * MIN) return ms;
        }
      }

      test("arm 15 — a pin in the SECOND 01:30 survives an unrelated save; editing its minute still moves it", async ({ page }) => {
        const pinMs = secondOneThirty();
        const pinIso = new Date(pinMs).toISOString();
        expect(wallClock(TZ, pinMs), "PRECONDITION: the pin sits in the REPEATED hour — an hour earlier shows the same wall clock")
          .toEqual(wallClock(TZ, pinMs - 60 * MIN));
        const { api, csrf } = await sa();
        let comp;
        try {
          // Two days before the pin, an hour long, pinned at creation.
          comp = await makeEvent(api, csrf, "booth", {
            start_time: new Date(Math.floor((pinMs - 2 * 24 * 60 * MIN) / MIN) * MIN - 60 * MIN).toISOString(),
            duration_minutes: 60, late_entry_deadline_at: pinIso,
          });
        } finally { await api.dispose(); }
        const stored = rawGetComp(comp.id).late_entry_deadline_at;
        expect(stored, "PRECONDITION: the pin is stored as sent").toBe(pinIso);

        await adminLogin(page);
        expect(await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone), "PRECONDITION: the browser runs in New York").toBe(TZ);
        await openEditor(page, comp.id);
        expect(await page.locator("#comp-tz").inputValue(), "PRECONDITION: so does the dialog").toBe(TZ);
        await expect(page.locator("#comp-late-auto"), "PRECONDITION: the editor opens on the pinned deadline").not.toBeChecked();
        await expect(page.locator("#comp-late-deadline-time")).toHaveValue("01:30");
        // THE AMBIGUITY, asserted: the pair reads back as the FIRST 01:30, an hour
        // before the pin — so an echo decided on the instant would call it edited.
        const readBack = await page.evaluate(() => window._compFormGetLateDeadline()?.toISOString());
        expect(readBack, "PRECONDITION: the pair reads back an hour early").toBe(new Date(pinMs - 60 * MIN - 15_000).toISOString());

        await setAttemptCap(page, 3);
        const puts = capturePuts(page);
        let answers;
        try { answers = await saveAndConfirm(page); } finally { puts.stop(); }
        expect(answers.join(" | ")).toMatch(/ -> 200 /);
        expect(puts.bodies.length, "one PUT was sent").toBe(1);
        expect(JSON.parse(puts.bodies[0]).late_entry_deadline_at, "the stored pin went back VERBATIM").toBe(stored);
        const after = rawGetComp(comp.id);
        expect(after.late_entry_deadline_at, "the column is byte-identical").toBe(stored);
        expect(after.attempt_cap, "and the field actually edited was written").toBe(3);

        // CONTROL: editing the minute IS a change, and the new wall clock is sent.
        await page.waitForFunction((id) => (window.S?.adminCompetitionsData || []).find(c => c.id === id)?.attempt_cap === 3, comp.id, { timeout: 20000 });
        await openEditor(page, comp.id);
        const t = page.locator("#comp-late-deadline-time");
        await t.fill("01:45");
        await t.dispatchEvent("change");
        const puts2 = capturePuts(page);
        let answers2;
        try { answers2 = await saveAndConfirm(page); } finally { puts2.stop(); }
        expect(answers2.join(" | ")).toMatch(/ -> 200 /);
        const sent = JSON.parse(puts2.bodies[0]).late_entry_deadline_at;
        expect(sent, "CONTROL: a changed minute is sent as the instant it now reads").toBe(new Date(pinMs - 60 * MIN + 15 * MIN - 15_000).toISOString());
        expect(rawGetComp(comp.id).late_entry_deadline_at, "CONTROL: and stored").toBe(sent);
      });
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The participant's screens
// ═══════════════════════════════════════════════════════════════════════════
test.describe("v8.6.0 — what a late entrant sees", () => {
  /** Enter an event the way a participant does: by pressing its card. */
  async function enterCard(page, compId) {
    const card = page.locator(`.comp-card[data-comp-id="${compId}"]`);
    await expect(card, "the event's card is in the picker").toHaveCount(1, { timeout: 20000 });
    await card.click();
    await expect(page.locator("#tasks-page"), "and pressing it enters the challenge view").toBeVisible({ timeout: 20000 });
  }

  /** Sign in through the API, THEN navigate (v7.21.26: never goto first). */
  async function signIn(page, email) {
    const r = await page.request.post("/api/csrf-token");
    void r;
    const c0 = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
    const login = await codeLogin(page.request, email, H(c0));
    expect(login.ok(), `participant login: ${await login.text()}`).toBeTruthy();
    await page.goto("/");
  }

  test("a late entrant gets a countdown and a Late entry chip; an ordinary participant does not", async ({ page }) => {
    const { api, csrf } = await sa();
    try {
      const comp = await makeEvent(api, csrf, "booth");
      const t = await api.post("/api/admin/tasks", {
        headers: H(csrf),
        data: { title: `LEU ${uniq()}`, description: "<p>x</p>", difficulty: "easy", answer_type: "text", correct_answer: "win", status: "published" },
      });
      expect(t.ok()).toBeTruthy();
      const taskId = (await t.json()).id;
      expect((await api.post(`/api/admin/tasks/${taskId}/competitions`, { headers: H(csrf), data: { competitionIds: [comp.id] } })).ok()).toBeTruthy();

      const late = await makeParticipant(api, csrf, uniq());
      const early = await makeParticipant(api, csrf, uniq());
      // A SECOND event, so the picker is reached rather than the sole-event landing
      // routing straight in (fixture checklist item 10).
      const other = await makeEvent(api, csrf, "booth");
      for (const u of [late, early]) {
        expect((await (await api.post("/api/admin/competitions/assign", { headers: H(csrf), data: { userIds: [u.id], competitionIds: [comp.id] } })).json()).assigned).toBe(1);
        expect((await (await api.post("/api/admin/competitions/assign", { headers: H(csrf), data: { userIds: [u.id], competitionIds: [other.id] } })).json()).assigned).toBe(1);
      }

      const effEnd = await expireEvent(comp.id);
      rawSetAssignedAt(comp.id, late.id, new Date(effEnd.getTime() + 5 * MIN).toISOString());
      rawSetAssignedAt(comp.id, early.id, new Date(effEnd.getTime() - 60 * MIN).toISOString());

      // ── THE SUBJECT ──
      await signIn(page, late.email);
      // THE REAL AFFORDANCE. `selectCompetition` establishes the session context and
      // returns — it does NOT route; its CALLER does (`routeVerdict` →
      // `enterCompetitionView`). Driving it directly leaves the participant on the
      // picker with a correct server answer and nothing rendered, which reads as a
      // product defect and is a harness one.
      await enterCard(page, comp.id);
      await expect(page.locator("#header-late-entry"), "the chip names what the countdown is for").toBeVisible({ timeout: 20000 });
      await expect(page.locator("#header-late-entry")).toHaveText(/late entry/i);
      // The countdown runs, which is what "they are still playing" looks like.
      await expect.poll(async () => (await page.locator("#header-timer").innerText()).trim(), { timeout: 15000 })
        .toMatch(/\d/);
      // The answer box is present, which is what the ENDED branch of the challenge
      // renderer replaces with a locked panel: `hackathon_ended` decides between
      // them, and for a late entrant the server answers false.
      await page.evaluate((id) => window.openTask(id), taskId);
      await expect(page.locator("#ans-text"), "a late entrant still has somewhere to type").toBeVisible({ timeout: 15000 });
      await expect(page.locator("#task-detail-card"), "and is not told submissions are closed")
        .not.toContainText(/Submissions are closed/i);

      // ── THE CONTROL. "The chip is visible" is equally satisfied by a build in
      // which the ended popup never fires for anybody.
      const page2 = await page.context().browser().newContext({ baseURL: BASE });
      const p2 = await page2.newPage();
      try {
        const c0 = (await (await p2.request.get("/api/csrf-token")).json()).csrfToken;
        expect((await codeLogin(p2.request, early.email, H(c0))).ok()).toBeTruthy();
        await p2.goto("/");
        await enterCard(p2, comp.id);
        await expect(p2.locator("#header-late-entry"), "an ordinary participant gets no chip").toBeHidden({ timeout: 20000 });
        await expect.poll(async () => await p2.evaluate(() => !!window.S?.hackathonEnded), { timeout: 20000 })
          .toBe(true);
      } finally { await page2.close(); }
    } finally { await api.dispose(); }
  });

  // THE JOIN LANDING (the sign-in card's event chip). A walk-up who scans the
  // booth's QR after its end, while late entries are open, is told the event
  // still takes them: "Late entry open" in the late-entry colours, as on the
  // Events list. The chip used its own table and read "Ended".
  test("a walk-up landing on an ended booth in its late window reads 'Late entry open', not 'Ended' (control: a live event reads 'Live')", async ({ browser }) => {
    const { api, csrf } = await sa();
    try {
      const late = await makeEvent(api, csrf, "booth");
      const live = await makeEvent(api, csrf, "booth");
      const tokenOf = async (c) => (await (await api.get(`/api/admin/competitions/${c.id}/self-enroll`)).json()).token;
      const lateTok = await tokenOf(late);
      const liveTok = await tokenOf(live);
      await expireEvent(late.id);
      const row = (await (await api.get("/api/admin/competitions")).json()).find((c) => c.id === late.id);
      expect([row.status, row.late_entry_window_open], "PRECONDITION: ended, with its late window open").toEqual(["ended", true]);

      /** The landing's chip, once the event's name is on the card. */
      const chipOn = async (token, name) => {
        const ctx = await browser.newContext({ baseURL: BASE });
        try {
          const page = await ctx.newPage();
          await page.goto(`/join/${token}`);
          await expect(page.locator("#join-banner-info"), "the card names the event").toHaveText(name, { timeout: 20000 });
          const chip = page.locator("#join-banner-chip");
          await expect(chip).toBeVisible();
          return await chip.evaluate((el) => ({ text: el.textContent.trim(), cls: el.className,
            filled: getComputedStyle(el).backgroundColor !== "rgba(0, 0, 0, 0)" }));
        } finally { await ctx.close(); }
      };
      expect(await chipOn(lateTok, late.name), "the late window, by the one status table and its colours")
        .toEqual({ text: "Late entry open", cls: "badge comp-badge comp-late-entry", filled: true });
      expect(await chipOn(liveTok, live.name), "CONTROL: a live event")
        .toEqual({ text: "Live", cls: "badge comp-badge comp-live", filled: true });
    } finally { await api.dispose(); }
  });

  test("the picker keeps an event whose late window is open, and still hides one whose is not", async ({ page }) => {
    const { api, csrf } = await sa();
    try {
      const open = await makeEvent(api, csrf, "booth");
      // ── THE CONTROL: an ended event with NO late window must STILL be hidden by
      // the default filter, or "the card is visible" is satisfied by a build that
      // stopped filtering ended events at all.
      const shut = await makeEvent(api, csrf, "booth", { late_entry_enabled: false });
      const p = await makeParticipant(api, csrf, uniq());
      for (const c of [open, shut]) {
        expect((await (await api.post("/api/admin/competitions/assign", { headers: H(csrf), data: { userIds: [p.id], competitionIds: [c.id] } })).json()).assigned).toBe(1);
      }
      await expireEvent(open.id);
      await expireEvent(shut.id);

      await signIn(page, p.email);
      await expect(page.locator("#comp-grid"), "the picker rendered").toBeVisible({ timeout: 20000 });
      await expect.poll(async () => page.locator(`.comp-card[data-comp-id="${open.id}"]`).count(), { timeout: 20000 })
        .toBe(1);
      await expect(page.locator(`.comp-card[data-comp-id="${open.id}"]`),
        "the card says both that the event ended and that late entry is open").toContainText(/Late entry open/i);
      await expect(page.locator(`.comp-card[data-comp-id="${shut.id}"]`),
        "an ended event with no window stays hidden by the default filter").toHaveCount(0);
    } finally { await api.dispose(); }
  });
});
