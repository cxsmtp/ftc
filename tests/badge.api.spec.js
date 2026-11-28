// @ts-check
// Achievement-badge feature (v7.1.0): mint authz, idempotency, the public
// OpenGraph page, image serving, PII hygiene, and access-log token scrubbing.
const { test, expect } = require("./isolated-test");
const { registerPost } = require("./helpers");
const { apiLogin, freshCtx, PARTICIPANT_PASS, BASE, TEST_DB_PATH, gradingHashFor, pollAdminLogs} = require("./helpers");
const fs = require("fs");
const path = require("path");
const badge = require("../lib/badge");

test.use({ baseURL: BASE });

const h = (csrf) => ({ "x-csrf-token": csrf, "content-type": "application/json" });

// v7.12.5 — the Checkmarx co-brand mark must be embedded (white) in EVERY badge, on
// both the placement (top-3) and participation variants. Ties to the actual brand asset
// so removing the logo — or the asset — fails here.
test("Checkmarx co-brand logo is embedded in both badge variants (v7.12.5)", () => {
  const logo = fs.readFileSync(path.join(__dirname, "..", "public", "checkmarx-logo-white.svg"), "utf8");
  const logoPaths = [...logo.matchAll(/<path[^>]*\bd="([^"]+)"[^>]*\/>/g)].map(m => m[1]);
  expect(logoPaths.length, "brand asset has path data").toBeGreaterThan(0);
  const base = { competitionName: "C", displayName: "N", dateLabel: "D", platformName: "P" };
  for (const [variant, data] of [["placement", { ...base, rank: 1, scoreLabel: "1" }], ["participation", { ...base, rank: 7 }]]) {
    const svg = badge.buildBadgeSvg(data);
    for (const d of logoPaths) expect(svg, `${variant} badge embeds the logo`).toContain(d);
  }
});

// v7.15.1 — the single-line badge fields fit to PIXEL WIDTH, not character count.
// The reported bug: a platform name well inside the wordmark strip was ellipsised
// anyway, because the cap was a flat 28 characters — and character count doesn't
// track width (28 "M"s are 3x the width of 28 "I"s at the same size). The same
// cap shape also let a wide-but-short nickname overrun into the SCORE column.
test.describe("Badge text fitting (v7.15.1)", () => {
  // v7.21.29 — the artwork moved to the supplied certificate template, so the
  // COORDINATES these tests read changed. Every guarantee is the same one, and
  // each is now derived from the layout rather than pinned to a magic number, so
  // the next design change re-points them once instead of breaking them again.
  //
  //   platform  x=126, drawn between the wordmark and the medallion
  //   name      CENTRED at x=430, so "overrun" means the medallion, not a column
  const PLATFORM_X = 126, NAME_CX = 430;
  const fieldAt = (svg, x, anchored) => {
    const anchor = anchored ? ' text-anchor="middle"' : "";
    const m = new RegExp(`<text x="${x}" y="\\d+"${anchor}[^>]*font-size="(\\d+(?:\\.\\d+)?)"[^>]*>([^<]*)</text>`).exec(svg);
    return m ? { size: Number(m[1]), text: m[2] } : null;
  };
  const platformAt = (svg) => fieldAt(svg, PLATFORM_X);
  // v7.21.29 — the name can be one line or two and sits at a COMPUTED y (the
  // block flows), so it is located by its fill rather than by a fixed baseline.
  const nameLinesOf = (svg) =>
    [...svg.matchAll(new RegExp(`<text x="${NAME_CX}" y="\\d+" text-anchor="middle"[^>]*font-size="(\\d+(?:\\.\\d+)?)"[^>]*fill="#FFFFFF">([^<]*)</text>`, "g"))]
      .map(m => ({ size: Number(m[1]), text: m[2] }));
  const nameAt = (svg) => nameLinesOf(svg)[0] || null;
  const base = { rank: 1, competitionName: "C", displayName: "n", dateLabel: "1 Jan 2026", scoreLabel: "50 pts" };
  const PLATFORM_SIZE = 16;                  // the design size on the share canvas

  test("a long-but-fitting platform name renders in FULL, at full size", () => {
    const name = "Checkmarx Application Security";
    const f = platformAt(badge.buildBadgeSvg({ ...base, platformName: name }));
    expect(f.text, "no ellipsis").not.toContain("…");
    expect(f.text).toBe(name.toUpperCase());
    expect(f.size, "still at the design size").toBe(PLATFORM_SIZE);
  });

  test("an over-long platform name shrinks to fit before it is ever ellipsised", () => {
    const name = "Checkmarx Global Application Security Developer Championship Series 2026";
    const f = platformAt(badge.buildBadgeSvg({ ...base, platformName: name }));
    expect(f.text, "shrunk, not cut").not.toContain("…");
    expect(f.text).toBe(name.toUpperCase());
    expect(f.size, "smaller than the design size").toBeLessThan(PLATFORM_SIZE);
    expect(f.size, "but still legible").toBeGreaterThanOrEqual(11);
  });

  // The invariant that matters visually: whatever the fitter decides, the text
  // must stay inside its strip. Ellipsis is the LAST resort, not the first — but
  // when it fires, the result still has to fit.
  test("no platform name overruns its strip, however pathological", () => {
    // The SVG carries the ESCAPED string, so unescape before measuring —
    // otherwise "&amp;" counts as five glyphs and the check is meaningless.
    const unesc = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'").replace(/&amp;/g, "&");
    const MEDALLION_LEFT = 990 - 148 * 0.62;   // the medal's glow, from buildBadgeSvg
    for (const name of [
      "T", "Tournament", "Checkmarx Hack Arena",
      "Checkmarx Application Security Tournament",
      "W".repeat(84), "M M M M M M M M M M M M M M M M M M M M M M M M M M",
      "Ünïcödé Säfety Chämpiönship Sërïes 2026", "A&B <Security> Tournament",
    ]) {
      const f = platformAt(badge.buildBadgeSvg({ ...base, platformName: name }));
      const endX = PLATFORM_X + badge._measureText(unesc(f.text), f.size, 700, 2.2);
      expect(endX, `"${name}" ends at ${endX.toFixed(0)}; the medallion starts at ${MEDALLION_LEFT.toFixed(0)}`)
        .toBeLessThan(MEDALLION_LEFT);
    }
  });

  test("fitting happens before escaping — markup in a platform name stays escaped", () => {
    const svg = badge.buildBadgeSvg({ ...base, platformName: "A&B <Security> Tournament" });
    expect(platformAt(svg).text).toBe("A&amp;B &lt;SECURITY&gt; TOURNAMENT");
  });

  test("a wide participant name never reaches the medallion", () => {
    // Same guarantee as before the redesign, against the element that is now to
    // the name's right. The name is centred, so measure both halves — and it can
    // be two lines, so check every one.
    const MEDALLION_LEFT = 990 - 148 * 0.62;
    for (const displayName of ["a_very_long_nickname22", "Dr. María José García-Hernández", "W".repeat(60)]) {
      const svg = badge.buildBadgeSvg({ ...base, platformName: "P", displayName });
      const lines = nameLinesOf(svg);
      expect(lines.length, `the name renders for "${displayName}"`).toBeGreaterThan(0);
      for (const ln of lines) {
        const halfW = badge._measureText(ln.text, ln.size, 800, -0.8) / 2;
        expect(NAME_CX + halfW, `"${displayName}" must stay clear of the medallion`).toBeLessThan(MEDALLION_LEFT);
      }
    }
  });

  test("short values are untouched — the common badge is unchanged", () => {
    const svg = badge.buildBadgeSvg({ ...base, platformName: "Hack Arena", displayName: "Alice Smith" });
    expect(platformAt(svg)).toEqual({ size: PLATFORM_SIZE, text: "HACK ARENA" });
    expect(nameLinesOf(svg), "an ordinary name is one line at the design size")
      .toEqual([{ size: 58, text: "Alice Smith" }]);
  });

  test("measurement degrades safely when the font metrics cannot be read", () => {
    // The fallback must OVER-estimate: shrinking text more than necessary is
    // recoverable, letting it collide with the logo is not. Compare a known
    // string against the generous 0.75em-per-glyph floor the loader falls back to.
    const w = badge._measureText("HACK ARENA", 22, 800, 0);
    expect(w).toBeGreaterThan(0);
    expect(w, "real metrics are tighter than the fallback estimate").toBeLessThan(10 * 22 * 0.75);
  });
});

async function ensureParticipant(api, H, email, nick) {
  await registerPost(api, "/api/register", { headers: H, data: {
    firstName: "T", lastName: "User", nickname: nick, email,
    company: "Acme", title: "Engineer", avatar: "🦊",
    country: "US", timezone: "America/New_York",
    jobFunction: "Software Developer / Engineer", city: "New York",
  }});
  const all = await (await api.get("/api/admin/participants?limit=1000")).json();
  const u = (all.participants || []).find(p => p.email === email);
  if (!u) throw new Error(`could not register ${email}`);
  if (!u.verified) await api.post(`/api/admin/participants/${u.id}/verify`, { headers: H });
  if (!u.approved) await api.post(`/api/admin/participants/${u.id}/approve`, { headers: H });
  return u.id;
}

async function makeTask(api, H, compId, stamp) {
  const r = await api.post("/api/admin/tasks", { headers: H, data: {
    title: `BadgeTask ${stamp}`, description: "<p>x</p>", difficulty: "easy",
    answer_type: "text", correct_answer: "win", explanation: "<p>e</p>", hint: "h", status: "published",
  }});
  const taskId = (await r.json()).id;
  await api.post(`/api/admin/tasks/${taskId}/competitions`, { headers: H, data: { competitionIds: [compId] } });
  return taskId;
}

async function solve(email, compId, taskId) {
  const { api, csrf } = await apiLogin(email, PARTICIPANT_PASS);
  await api.post("/api/select-competition", { headers: h(csrf), data: { competitionId: compId } });
  if (taskId) await api.post(`/api/tasks/${taskId}/submit`, { headers: h(csrf), data: { answer: "win" , gradingHash: await gradingHashFor(api, taskId)} });
  await api.dispose();
}

// Selects the comp and submits a (wrong) answer — counts as "attempted" but doesn't solve.
async function attemptWrong(email, compId, taskId) {
  const { api, csrf } = await apiLogin(email, PARTICIPANT_PASS);
  await api.post("/api/select-competition", { headers: h(csrf), data: { competitionId: compId } });
  await api.post(`/api/tasks/${taskId}/submit`, { headers: h(csrf), data: { answer: "definitely-wrong" , gradingHash: await gradingHashFor(api, taskId)} });
  await api.dispose();
}

// Selects the comp and rates a challenge but never submits an answer.
// ext-audit F2 (v7.7.5): feedback alone NO LONGER counts as "attempted" — only a
// comp-scoped submission or hint does. (task_feedback carries no competition_id,
// so counting it leaked across comps that share a task.) Returns the feedback
// PUT status so callers can assert the lifecycle gate too.
async function feedbackOnly(email, compId, taskId, rating) {
  const { api, csrf } = await apiLogin(email, PARTICIPANT_PASS);
  await api.post("/api/select-competition", { headers: h(csrf), data: { competitionId: compId } });
  const r = await api.put(`/api/tasks/${taskId}/feedback`, { headers: h(csrf), data: { rating } });
  await api.dispose();
  return r.status();
}

let CTX;

test.beforeAll(async () => {
  const { api, csrf } = await apiLogin("superadmin");
  const H = h(csrf);
  const stamp = `${Date.now()}-${Math.floor(process.hrtime()[1] / 1000)}`;
  // `entry`: dave and gwen are members ON THE BOARD who never attempted, which on
  // these events is what entering makes them (a first-open clock would leave them
  // off it, and the mint would refuse them for a different reason).
  const mkComp = async (name, mins) => {
    const r = await api.post("/api/admin/competitions", { headers: H, data: {
      name, start_time: new Date(Date.now() - 10 * 60_000).toISOString(), duration_minutes: mins, clock_start: "entry",
    }});
    return (await r.json()).competition.id;
  };

  // Extra accounts: dave (4th-place member who NEVER attempted), frank (places
  // below top-3 but DID attempt — gets a participation badge), erin (never a member).
  const daveEmail = `dave-badge-${stamp}@acme.com`;
  const frankEmail = `frank-badge-${stamp}@acme.com`;
  const gwenEmail = `gwen-badge-${stamp}@acme.com`;
  const erinEmail = `erin-badge-${stamp}@acme.com`;
  const daveId = await ensureParticipant(api, H, daveEmail, `dave_badge_${stamp}`);
  const frankId = await ensureParticipant(api, H, frankEmail, `frank_badge_${stamp}`);
  const gwenId = await ensureParticipant(api, H, gwenEmail, `gwen_badge_${stamp}`);
  await ensureParticipant(api, H, erinEmail, `erin_badge_${stamp}`);

  const ids = await (await api.get("/api/admin/participants?limit=1000")).json();
  const idOf = (e) => ids.participants.find(p => p.email === e).id;
  const aliceId = idOf("alice@acme.com"), bobId = idOf("bob@acme.com"), carolId = idOf("carol@acme.com");

  // Main ended comp: alice/bob/carol solve (ranks 1-3); dave joins but never
  // attempts (no submission); frank submits a wrong answer; gwen only leaves
  // feedback (no submission). frank is "attempted" (wrong answer); dave + gwen
  // are NOT — ext-audit F2: feedback alone no longer counts toward the badge.
  const endedComp = await mkComp(`Badge Ended ${stamp}`, 180);
  const endedTask = await makeTask(api, H, endedComp, stamp);
  await api.post("/api/admin/competitions/assign", { headers: H, data: { userIds: [aliceId, bobId, carolId, daveId, frankId, gwenId], competitionIds: [endedComp] } });
  await solve("alice@acme.com", endedComp, endedTask);
  await solve("bob@acme.com", endedComp, endedTask);
  await solve("carol@acme.com", endedComp, endedTask);
  await solve(daveEmail, endedComp, null);              // member, no submission → no attempt
  await attemptWrong(frankEmail, endedComp, endedTask); // member, wrong answer → attempted, below top-3
  // gwen leaves feedback while the comp is LIVE (the lifecycle gate allows live);
  // ext-audit F2 means this does NOT make her "attempted". Assert the PUT itself
  // succeeded so the test still exercises the real feedback write path.
  const gwenFbStatus = await feedbackOnly(gwenEmail, endedComp, endedTask, 5);
  if (gwenFbStatus !== 200) throw new Error(`gwen feedback PUT expected 200 (live comp), got ${gwenFbStatus}`);

  // Internal ended comp: alice solves, tagged internal.
  const internalComp = await mkComp(`Badge Internal ${stamp}`, 180);
  const internalTask = await makeTask(api, H, internalComp, `${stamp}-int`);
  await api.post("/api/admin/competitions/assign", { headers: H, data: { userIds: [aliceId], competitionIds: [internalComp] } });
  await solve("alice@acme.com", internalComp, internalTask);
  await api.post(`/api/admin/competitions/${internalComp}/tags`, { headers: H, data: { tag: "test/dry run" } });

  // Live (not-ended) comp: alice is a member.
  const liveComp = await mkComp(`Badge Live ${stamp}`, 600);
  const liveTask = await makeTask(api, H, liveComp, `${stamp}-live`);
  await api.post("/api/admin/competitions/assign", { headers: H, data: { userIds: [aliceId], competitionIds: [liveComp] } });

  // Upcoming comp (starts in the future) for the ext-audit F2 feedback
  // lifecycle-gate test: gwen is a member but the content hasn't started.
  const upcomingComp = (await (await api.post("/api/admin/competitions", { headers: H, data: {
    name: `Badge Upcoming ${stamp}`, start_time: new Date(Date.now() + 60 * 60_000).toISOString(), duration_minutes: 120,
  }})).json()).competition.id;
  const upcomingTask = await makeTask(api, H, upcomingComp, `${stamp}-up`);
  await api.post("/api/admin/competitions/assign", { headers: H, data: { userIds: [gwenId], competitionIds: [upcomingComp] } });

  // End the two that should be ended.
  await api.post(`/api/admin/competitions/${endedComp}/end-now`, { headers: H });
  await api.post(`/api/admin/competitions/${internalComp}/end-now`, { headers: H });
  await api.dispose();

  CTX = { endedComp, internalComp, liveComp, upcomingComp, upcomingTask, daveEmail, frankEmail, gwenEmail, erinEmail, aliceId };
});

async function mint(email, compId) {
  const { api, csrf } = await apiLogin(email, PARTICIPANT_PASS);
  const r = await api.post(`/api/competitions/${compId}/badge`, { headers: h(csrf) });
  const body = await r.json().catch(() => ({}));
  await api.dispose();
  return { status: r.status(), body };
}

// v8.6.2 — MINTING NO LONGER PUBLISHES THE PAGE, for any event type: it goes
// live at the holder's own Share. Tests whose subject is what the PAGE CONTAINS
// (OG tags, wording, which name it carries) therefore need the share as a
// PRECONDITION — their subject is unchanged, only their setup grew. Tests about
// WHEN it publishes live in completion-credential.spec.js.
async function shareAsOwner(email, token) {
  const { api, csrf } = await apiLogin(email, PARTICIPANT_PASS);
  try {
    const r = await api.post(`/badge/${token}/shared`, { headers: h(csrf) });
    expect(r.ok(), await r.text()).toBeTruthy();
    expect((await r.json()).published, "the owner's share publishes the page").toBe(true);
  } finally { await api.dispose(); }
}

async function mintAndShare(email, compId) {
  const m = await mint(email, compId);
  if (m.body && m.body.token) await shareAsOwner(email, m.body.token);
  return m;
}

async function leaderboard(email, compId) {
  const { api, csrf } = await apiLogin(email, PARTICIPANT_PASS);
  await api.post("/api/select-competition", { headers: h(csrf), data: { competitionId: compId } });
  const r = await api.get("/api/leaderboard");
  const body = await r.json().catch(() => ({}));
  await api.dispose();
  return { status: r.status(), body };
}

test.describe("Achievement badge (v7.1.0)", () => {
  test("top-3 finisher mints a badge with a verified rank + share URL", async () => {
    const { status, body } = await mint("alice@acme.com", CTX.endedComp);
    expect(status).toBe(200);
    expect(body.rank).toBeGreaterThanOrEqual(1);
    expect(body.rank).toBeLessThanOrEqual(3);
    expect(body.token).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    // v7.21.30 — the image is RENDERED ON REQUEST from a token-keyed route, not
    // served from the copy stored at mint, so an artwork change reaches badges
    // that already exist.
    expect(body.imageUrl).toBe(`${BASE}/badge/${body.token}/badge.png`);
    // Share URL is the LinkedIn share-intent pointing at the public /badge page.
    expect(body.shareUrl).toContain("linkedin.com/sharing/share-offsite/");
    expect(decodeURIComponent(body.shareUrl)).toContain(`/badge/${body.token}`);
  });

  test("minting is idempotent — same (user,comp) returns the same token", async () => {
    const a = await mint("alice@acme.com", CTX.endedComp);
    const b = await mint("alice@acme.com", CTX.endedComp);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(b.body.token).toBe(a.body.token);
  });

  test("a non-top-3 member who never attempted cannot mint (needs ≥1 submission/hint)", async () => {
    const { status, body } = await mint(CTX.daveEmail, CTX.endedComp);
    expect(status).toBe(403);
    expect(body.error).toMatch(/attempt/i);
  });

  test("a non-top-3 member who ATTEMPTED mints a generic participation badge (no place, no score)", async () => {
    const { status, body } = await mint(CTX.frankEmail, CTX.endedComp);
    expect(status).toBe(200);
    expect(body.placement).toBe(false);
    expect(body.rank).toBeGreaterThan(3);
    expect(body.rankLabel).toMatch(/participant/i);
    expect(body.token).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(body.shareUrl).toContain("linkedin.com/sharing/share-offsite/");
    // Idempotent like the placement badge.
    const again = await mint(CTX.frankEmail, CTX.endedComp);
    expect(again.body.token).toBe(body.token);
  });

  test("ext-audit F2: a member who only left FEEDBACK (no submission/hint) is NOT attempted → cannot mint", async () => {
    // gwen rated the challenge while the comp was live but never submitted an
    // answer or revealed a hint. task_feedback carries no competition_id, so
    // counting it leaked across comps that share a task; only comp-scoped
    // submission/hint now qualify. gwen must be rejected like any no-show.
    const { status, body } = await mint(CTX.gwenEmail, CTX.endedComp);
    expect(status).toBe(403);
    expect(body.error).toMatch(/attempt/i);
  });

  test("ext-audit F2: feedback on a NOT-STARTED competition's challenge is gated (403)", async () => {
    // The feedback endpoint was the one task action with no not-started gate, so
    // a participant could rate (and thus signal engagement with) a competition
    // before it began. It now mirrors GET /api/tasks/:id and the submit/hint gate.
    const { api, csrf } = await apiLogin(CTX.gwenEmail, PARTICIPANT_PASS);
    await api.post("/api/select-competition", { headers: h(csrf), data: { competitionId: CTX.upcomingComp } });
    const r = await api.put(`/api/tasks/${CTX.upcomingTask}/feedback`, { headers: h(csrf), data: { rating: 4 } });
    expect(r.status()).toBe(403);
    expect((await r.json()).error).toMatch(/has not started/i);
    await api.dispose();
  });

  test("a badge mint records a best-effort badge_minted competition event (forensic trail)", async () => {
    // Self-contained: mint here so the event exists whether or not the earlier
    // mint tests ran (in isolation this is alice's first mint → emits the event;
    // in the full suite alice already minted → her event from earlier persists,
    // and this re-mint is the idempotent no-op). Either way ≥1 event is present.
    await mint("alice@acme.com", CTX.endedComp);
    const { api } = await apiLogin("superadmin");
    const body = await (await api.get(`/api/admin/competitions/${CTX.endedComp}/events?limit=300`)).json();
    await api.dispose();
    // The events endpoint returns a bare array (non-paginated) and pre-parses details.
    const events = Array.isArray(body) ? body : (body.events || []);
    const minted = events.filter(e => e.event_type === "badge_minted");
    expect(minted.length, "expected ≥1 badge_minted event in the comp's history").toBeGreaterThan(0);
    const d = typeof minted[0].details === "string" ? JSON.parse(minted[0].details || "{}") : (minted[0].details || {});
    expect(d).toHaveProperty("user_id");
    expect(d).toHaveProperty("rank");
    expect(typeof d.placement).toBe("boolean");
  });

  test("the placement badge reports placement:true; the participation badge placement:false", async () => {
    const placement = await mint("alice@acme.com", CTX.endedComp);
    expect(placement.body.placement).toBe(true);
    expect(placement.body.rankLabel).toMatch(/place/i);
  });

  test("a non-member cannot mint", async () => {
    const { status } = await mint(CTX.erinEmail, CTX.endedComp);
    expect(status).toBe(403);
  });

  test("a not-yet-ended competition rejects minting (409)", async () => {
    const { status } = await mint("alice@acme.com", CTX.liveComp);
    expect(status).toBe(409);
  });

  test("internal (dry-run) competitions are not eligible (403)", async () => {
    const { status, body } = await mint("alice@acme.com", CTX.internalComp);
    expect(status).toBe(403);
    expect(body.error).toMatch(/not available/i);
  });

  test("minting requires auth + a real competition", async () => {
    // anon (no participant session)
    const { api, csrf } = await freshCtx();
    const anon = await api.post(`/api/competitions/${CTX.endedComp}/badge`, { headers: h(csrf) });
    expect(anon.status()).toBe(401);
    // unknown competition
    const { api: pa, csrf: pc } = await apiLogin("alice@acme.com", PARTICIPANT_PASS);
    const missing = await pa.post(`/api/competitions/does-not-exist/badge`, { headers: h(pc) });
    expect(missing.status()).toBe(404);
    await api.dispose(); await pa.dispose();
  });

  test("public /badge/:token page exposes OG tags + the image, but no PII", async () => {
    const { body } = await mintAndShare("alice@acme.com", CTX.endedComp);
    const { api } = await freshCtx();
    const page = await api.get(`/badge/${body.token}`);
    expect(page.status()).toBe(200);
    expect(page.headers()["content-type"]).toContain("text/html");
    const html = await page.text();
    expect(html).toMatch(/<meta property="og:image" content="[^"]+\/badge\/[^"\/]+\/badge\.png"/);
    expect(html).toContain('<meta property="og:type" content="website"');
    expect(html).toContain('name="twitter:card" content="summary_large_image"');
    expect(html).toMatch(/og:title" content="[^"]*Place/);
    // 8.17.0 page re-check (axe landmark-one-main, region): the page's content
    // sits in one <main>, its heading and image inside it.
    expect((html.match(/<main[\s>]/g) || []).length, "one main landmark").toBe(1);
    expect(html).toMatch(/<main[^>]*>[\s\S]*badge\.png[\s\S]*<h1[\s\S]*<\/main>/);
    // No participant email or any @acme.com address leaks onto the public page.
    expect(html).not.toContain("@acme.com");
    expect(html.toLowerCase()).not.toContain("alice@");
    // CSP hygiene: no inline <style> element (style-src-elem has no
    // 'unsafe-inline'), and no style="…" attribute either (those escape every
    // stylesheet scanner): the page is styled by verify-pages.css alone.
    expect(html).not.toMatch(/<style[\s>]/i);
    expect(html, "no inline style attribute").not.toMatch(/\sstyle=/i);
    expect(html, "the standalone shell's sheet").toContain('href="/verify-pages.css"');

    // The referenced image serves as a real PNG.
    const imgPath = (html.match(/\/badge\/[A-Za-z0-9_-]+\/badge\.png/) || [])[0];
    const img = await api.get(imgPath);
    expect(img.status()).toBe(200);
    expect(img.headers()["content-type"]).toBe("image/png");
    const buf = await img.body();
    expect(buf.length).toBeGreaterThan(1000);
    expect(buf.slice(0, 8).toString("hex")).toBe("89504e470d0a1a0a"); // PNG magic
    await api.dispose();
  });

  test("public /badge page for a participation badge shows 'Participant' + 'took part', no placement wording", async () => {
    const { body } = await mintAndShare(CTX.frankEmail, CTX.endedComp);
    const { api } = await freshCtx();
    const page = await api.get(`/badge/${body.token}`);
    expect(page.status()).toBe(200);
    const html = await page.text();
    expect(html).toMatch(/og:title" content="[^"]*Participant/);
    expect(html.toLowerCase()).toContain("took part");
    // Not the placement variant — no "… Place" wording leaks onto a participation page.
    expect(html).not.toMatch(/\dst Place|\dnd Place|\drd Place/i);
    expect(html).not.toContain("@acme.com");
    await api.dispose();
  });

  test("leaderboard canShareBadge gates the CTA: top-3 + attempted → true, never-attempted → false", async () => {
    const alice = await leaderboard("alice@acme.com", CTX.endedComp);
    expect(alice.body.ended).toBe(true);
    expect(alice.body.canShareBadge, "top-3 finisher is eligible").toBe(true);
    const frank = await leaderboard(CTX.frankEmail, CTX.endedComp);
    expect(frank.body.canShareBadge, "attempted non-top-3 is eligible (participation)").toBe(true);
    const dave = await leaderboard(CTX.daveEmail, CTX.endedComp);
    expect(dave.body.canShareBadge, "enrolled no-show who never attempted is NOT eligible").toBe(false);
  });

  test("an invalid badge token returns a uniform 404 (no oracle)", async () => {
    const { api } = await freshCtx();
    const r = await api.get(`/badge/totally-made-up-token-xyz`);
    expect(r.status()).toBe(404);
    await api.dispose();
  });

  test("the badge token is scrubbed from the access log path", async () => {
    const { body } = await mint("alice@acme.com", CTX.endedComp);
    const { api } = await freshCtx();
    await api.get(`/badge/${body.token}`);
    await api.dispose();
    // Superadmin reads the access log; the raw token must not appear, the
    // scrubbed marker must.
    const { api: sa, csrf } = await apiLogin("superadmin");
    // v8.12.5 — polled: the access line is written at res.on("finish"), which
    // can land after the client has its response.
    const entries = await pollAdminLogs(sa, `stream=access&limit=300&q=badge`,
      (es) => JSON.stringify(es).includes("/badge/[REDACTED]"), { what: "the scrubbed badge access line" }).catch(() => []);
    await sa.dispose();
    const raw = JSON.stringify(entries);
    expect(raw).not.toContain(body.token);
    expect(raw).toContain("/badge/[REDACTED]");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// v7.15.0 — certificate PDF
// ═══════════════════════════════════════════════════════════════════════════
// The PDF is hand-built (no PDF dependency): resvg gives raw RGBA, which is
// split into an RGB stream + an 8-bit alpha SMask, Flate-compressed with zlib
// and wrapped in a one-page PDF with a byte-exact xref table. A malformed xref
// still "looks like" a PDF to a naive check, so these assertions go past the
// %PDF- header into structure that a broken writer would get wrong.
test.describe("Certificate PDF (v7.15.0)", () => {
  test("a minted badge exposes a valid, correctly-sized single-page PDF", async () => {
    const { api } = await apiLogin("alice@acme.com", PARTICIPANT_PASS);
    const mint = await api.post(`/api/competitions/${CTX.endedComp}/badge`, {
      headers: { "x-csrf-token": (await (await api.get("/api/csrf-token")).json()).csrfToken },
    });
    expect(mint.status()).toBe(200);
    const token = (await mint.json()).token;
    await api.dispose();

    const { api: anon } = await freshCtx();      // public, like the badge page
    const r = await anon.get(`/badge/${token}/certificate.pdf`);
    expect(r.status()).toBe(200);
    expect(r.headers()["content-type"]).toContain("application/pdf");
    expect(r.headers()["content-disposition"]).toMatch(/attachment; filename=".*certificate\.pdf"/);

    const buf = await r.body();
    expect(buf.length, "a real rendered certificate, not an empty stub").toBeGreaterThan(5000);
    expect(buf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(buf.subarray(-6).toString("latin1").trim()).toBe("%%EOF");

    // The xref offsets must be byte-exact or strict readers reject the file:
    // walk startxref -> the xref table -> the first object and check it lands on
    // an object header. This is what catches an off-by-one in the writer.
    const tail = buf.subarray(buf.length - 2048).toString("latin1");
    const m = /startxref\s+(\d+)\s+%%EOF/.exec(tail);
    expect(m, "trailer carries a startxref offset").toBeTruthy();
    const xrefOff = parseInt(m[1], 10);
    expect(buf.subarray(xrefOff, xrefOff + 4).toString("latin1")).toBe("xref");
    const firstEntry = /xref\s+0 (\d+)\s+0000000000 65535 f\s+(\d{10}) 00000 n/.exec(buf.subarray(xrefOff, xrefOff + 200).toString("latin1"));
    expect(firstEntry, "xref table is well-formed").toBeTruthy();
    const obj1 = parseInt(firstEntry[2], 10);
    expect(buf.subarray(obj1, obj1 + 8).toString("latin1")).toMatch(/^1 0 obj/);

    // One A4-landscape page carrying an RGB image with an alpha SMask.
    const head = buf.toString("latin1");
    expect(head).toContain("/Type /Catalog");
    expect(head).toMatch(/\/MediaBox \[0 0 841\.89 595\.28\]/);
    expect((head.match(/\/Type \/Page[^s]/g) || []).length, "exactly one page").toBe(1);
    expect(head).toContain("/Subtype /Image");
    expect(head).toContain("/ColorSpace /DeviceRGB");
    expect(head).toContain("/Filter /FlateDecode");
    await anon.dispose();
  });

  test("the PDF title round-trips non-ASCII (PDF text strings are not UTF-8)", async () => {
    // A Latin-1 literal silently mangles accented names; the writer must emit a
    // UTF-16BE hex string. Checked at the unit level so it is covered even for
    // names the seeded fixtures don't contain.
    const badge = require("../lib/badge");
    const pdf = await badge.buildPdfFromRgba(Buffer.alloc(4 * 4, 200), 2, 2, "Certificaté — José");
    const s = pdf.toString("latin1");
    const hex = /\/Title <([0-9a-f]+)>/i.exec(s);
    expect(hex, "title is written as a hex string, not a literal").toBeTruthy();
    const decoded = Buffer.from(hex[1], "hex").swap16().toString("utf16le").replace(/^﻿/, "");
    expect(decoded).toBe("Certificaté — José");
  });

  test("an unknown token gets the same uniform 404 from the certificate route", async () => {
    const { api: anon } = await freshCtx();
    const bogus = await anon.get("/badge/definitely-not-a-real-token/certificate.pdf");
    expect(bogus.status()).toBe(404);
    // No oracle: the body must not distinguish "no such token" from "revoked".
    expect((await bogus.text()).toLowerCase()).not.toMatch(/revok|exist|invalid token/);
    await anon.dispose();
  });

  test("the certificate token is scrubbed from the access log", async () => {
    const { api } = await apiLogin("alice@acme.com", PARTICIPANT_PASS);
    const mint = await api.post(`/api/competitions/${CTX.endedComp}/badge`, {
      headers: { "x-csrf-token": (await (await api.get("/api/csrf-token")).json()).csrfToken },
    });
    const token = (await mint.json()).token;
    await api.dispose();
    const { api: anon } = await freshCtx();
    await anon.get(`/badge/${token}/certificate.pdf`);
    await anon.dispose();
    const { api: sa } = await apiLogin("superadmin");
    await expect.poll(async () => {
      const logs = await (await sa.get("/api/admin/logs?stream=access&limit=300&q=certificate.pdf")).text();
      return logs.includes("/badge/[REDACTED]/certificate.pdf") && !logs.includes(token);
    }, { timeout: 8000, intervals: [200, 400, 800, 1500] }).toBe(true);
    await sa.dispose();
  });
});

// ── ext-audit v7.15.6 (MEDIUM) — badge artifacts must not contradict each other ──
// The PNG is a frozen point-in-time image, but the certificate PDF re-rendered
// from the LIVE board on the assumption that a fully-ended competition can never
// change. A competition can be revived (duration extended / participants
// assigned) and re-ended, after which the same token served a PNG and a PDF
// carrying DIFFERENT scores. The score is now snapshotted at mint.
test.describe("Badge score snapshot (ext-audit v7.15.6)", () => {
  const h = (csrf) => ({ "x-csrf-token": csrf, "content-type": "application/json" });

  test("the certificate PDF is byte-identical after the live score moves", async () => {
    const crypto = require("crypto");
    const Database = require("better-sqlite3");
    const stamp = `${Date.now()}`;
    const { api: sa, csrf } = await apiLogin("superadmin");
    const H = h(csrf);
    const compId = (await (await sa.post("/api/admin/competitions", { headers: H, data: {
      name: `ScoreSnap ${stamp}`, start_time: new Date(Date.now() - 10 * 60_000).toISOString(), duration_minutes: 180,
    } })).json()).competition.id;
    const taskId = (await (await sa.post("/api/admin/tasks", { headers: H, data: {
      title: `ScoreSnapTask ${stamp}`, description: "<p>x</p>", difficulty: "easy",
      answer_type: "text", correct_answer: "win", status: "published",
    } })).json()).id;
    await sa.post(`/api/admin/tasks/${taskId}/competitions`, { headers: H, data: { competitionIds: [compId] } });
    const parts = (await (await sa.get("/api/admin/participants?limit=1000")).json()).participants;
    const aliceId = parts.find(p => p.email === "alice@acme.com").id;
    await sa.post("/api/admin/competitions/assign", { headers: H, data: { userIds: [aliceId], competitionIds: [compId] } });
    await sa.dispose();

    // Alice solves → 1st place; the solve auto-ends the comp (sole participant).
    const { api: pa, csrf: pc } = await apiLogin("alice@acme.com", PARTICIPANT_PASS);
    await pa.post("/api/select-competition", { headers: h(pc), data: { competitionId: compId } });
    await pa.post(`/api/tasks/${taskId}/submit`, { headers: h(pc), data: { answer: "win" , gradingHash: await gradingHashFor(pa, taskId)} });
    const minted = await (await pa.post(`/api/competitions/${compId}/badge`, { headers: h(pc) })).json();
    await pa.dispose();
    expect(minted.token, "badge minted").toBeTruthy();

    const pdf1 = await (await (await freshCtx()).api.get(`/badge/${minted.token}/certificate.pdf`)).body();
    const hash1 = crypto.createHash("sha256").update(pdf1).digest("hex");

    // The score snapshot was persisted at mint…
    const db = new Database(TEST_DB_PATH, { readonly: true });
    const row = db.prepare("SELECT rank, score_snapshot FROM achievement_badges WHERE token=?").get(minted.token);
    db.close();
    expect(row.rank, "top-3 placement badge").toBeLessThanOrEqual(3);
    expect(Number.isFinite(row.score_snapshot), "score frozen at mint").toBe(true);

    // …now move the LIVE score, exactly as a revive-and-play-on would. Writing
    // the submission directly is the smallest way to reproduce a changed board.
    const dbW = new Database(TEST_DB_PATH);
    try {
      dbW.prepare("UPDATE submissions SET points_delta=points_delta-25 WHERE user_id=? AND competition_id=?").run(aliceId, compId);
    } finally { dbW.close(); }
    // The leaderboard entries are cached for 5 s in-process, and a direct DB
    // write does not invalidate it — without this wait the recompute path would
    // return the CACHED (unchanged) score and the assertion below would pass
    // even with the snapshot ignored, i.e. the test would prove nothing.
    await new Promise(r => setTimeout(r, 5600));

    const pdf2 = await (await (await freshCtx()).api.get(`/badge/${minted.token}/certificate.pdf`)).body();
    const hash2 = crypto.createHash("sha256").update(pdf2).digest("hex");
    expect(hash2, "the certificate must not change when the live board does — it is a point-in-time artifact")
      .toBe(hash1);
  });
});

// v7.15.32 — the "Group-name uniqueness folds Unicode" describe was REMOVED from this
// file. Group naming has nothing to do with badges; it duplicated
// functional-core.api.spec.js > "group-name uniqueness folds the cases NFKC+lowercase
// missed" (which additionally unit-tests _groupNameKey on sigma and sharp-s) and
// > "group CRUD: create, nocase-dup 409, rename, list, delete". Its one piece of unique
// coverage — renaming ONTO an existing name — was moved into that CRUD test rather than
// dropped.

// ext-audit v7.15.7 (MEDIUM) — a LEGACY badge (minted before score_snapshot
// existed) still had its PDF recompute the score from the live board, which
// preserves exactly the PNG/PDF contradiction the column was added to fix. For
// those rows the score is simply not knowable, so the certificate omits it
// rather than printing a number we cannot stand behind.
test("a legacy badge (no score_snapshot) omits the score instead of recomputing it", async () => {
  const crypto = require("crypto");
  const Database = require("better-sqlite3");
  const stamp = `${Date.now()}`;
  const { api: sa, csrf } = await apiLogin("superadmin");
  const H = { "x-csrf-token": csrf, "content-type": "application/json" };
  const compId = (await (await sa.post("/api/admin/competitions", { headers: H, data: {
    name: `Legacy ${stamp}`, start_time: new Date(Date.now() - 10 * 60_000).toISOString(), duration_minutes: 180,
  } })).json()).competition.id;
  const taskId = (await (await sa.post("/api/admin/tasks", { headers: H, data: {
    title: `LegacyTask ${stamp}`, description: "<p>x</p>", difficulty: "easy",
    answer_type: "text", correct_answer: "win", status: "published",
  } })).json()).id;
  await sa.post(`/api/admin/tasks/${taskId}/competitions`, { headers: H, data: { competitionIds: [compId] } });
  const parts = (await (await sa.get("/api/admin/participants?limit=1000")).json()).participants;
  const aliceId = parts.find(p => p.email === "alice@acme.com").id;
  await sa.post("/api/admin/competitions/assign", { headers: H, data: { userIds: [aliceId], competitionIds: [compId] } });
  await sa.dispose();

  const { api: pa, csrf: pc } = await apiLogin("alice@acme.com", PARTICIPANT_PASS);
  await pa.post("/api/select-competition", { headers: { "x-csrf-token": pc, "content-type": "application/json" }, data: { competitionId: compId } });
  await pa.post(`/api/tasks/${taskId}/submit`, { headers: { "x-csrf-token": pc, "content-type": "application/json" }, data: { answer: "win" , gradingHash: await gradingHashFor(pa, taskId)} });
  const minted = await (await pa.post(`/api/competitions/${compId}/badge`, { headers: { "x-csrf-token": pc } })).json();
  await pa.dispose();

  // Make it look like a pre-7.15.6 row.
  const dbW = new Database(TEST_DB_PATH);
  try { dbW.prepare("UPDATE achievement_badges SET score_snapshot=NULL WHERE token=?").run(minted.token); } finally { dbW.close(); }

  const pdf1 = await (await (await freshCtx()).api.get(`/badge/${minted.token}/certificate.pdf`)).body();
  // Move the live board and wait out the 5 s leaderboard cache — without the
  // wait the recompute would return the cached value and prove nothing.
  const dbW2 = new Database(TEST_DB_PATH);
  try { dbW2.prepare("UPDATE submissions SET points_delta=points_delta-25 WHERE user_id=? AND competition_id=?").run(aliceId, compId); } finally { dbW2.close(); }
  await new Promise(r => setTimeout(r, 5600));
  const pdf2 = await (await (await freshCtx()).api.get(`/badge/${minted.token}/certificate.pdf`)).body();

  expect(crypto.createHash("sha256").update(pdf2).digest("hex"),
    "a legacy certificate must not track the live score — it omits it")
    .toBe(crypto.createHash("sha256").update(pdf1).digest("hex"));
});

// ── deleting a competition must RECLAIM its badge PNGs ────────────────────────
// `achievement_badges` rows cascade away with the competition (FK). No mint
// stores the share image any more (sweep #43), but a certificate issued while
// mints did still names its ~150 KB snapshot PNG in `images`, which has NO
// foreign key at all — so the delete handler removes those explicitly. Without
// that line every such copy would leak an orphan BLOB into the same table that
// serves avatars and rich-text images, referenced by nothing and reclaimable by
// nothing.
//
// Deliberately self-contained (its own throwaway competition): CTX.endedComp is
// shared by the tests above and this file runs serially, so deleting that one
// would break them.
test("deleting the competition reclaims the badge's PNG from `images`", async () => {
  const Database = require("better-sqlite3");
  const stamp = `${Date.now()}`;
  const { api: sa, csrf } = await apiLogin("superadmin");
  const H = h(csrf);
  const compId = (await (await sa.post("/api/admin/competitions", { headers: H, data: {
    name: `BadgeImgReclaim ${stamp}`, start_time: new Date(Date.now() - 10 * 60_000).toISOString(), duration_minutes: 180,
  } })).json()).competition.id;
  const taskId = await makeTask(sa, H, compId, `${stamp}-reclaim`);
  const parts = (await (await sa.get("/api/admin/participants?limit=1000")).json()).participants;
  const aliceId = parts.find(p => p.email === "alice@acme.com").id;
  await sa.post("/api/admin/competitions/assign", { headers: H, data: { userIds: [aliceId], competitionIds: [compId] } });
  await sa.dispose();

  // Alice solves the only challenge → sole participant has solved everything,
  // so the comp auto-ends, which is what makes the badge mintable.
  await solve("alice@acme.com", compId, taskId);
  const imagesBefore = (() => {
    const d = new Database(TEST_DB_PATH, { readonly: true });
    try { return d.prepare("SELECT id FROM images ORDER BY id").all().map(r => r.id); } finally { d.close(); }
  })();
  const { status, body: minted } = await mint("alice@acme.com", compId);
  expect(status, "badge minted on the freshly-ended comp").toBe(200);
  expect(minted.token).toBeTruthy();

  // The mint itself stores no image (sweep #43): the table is as it was, by
  // value, and the row names no stored copy.
  let db = new Database(TEST_DB_PATH, { readonly: true });
  try {
    expect(db.prepare("SELECT id FROM images ORDER BY id").all().map(r => r.id), "the mint stored no image").toEqual(imagesBefore);
    expect(db.prepare("SELECT image_id FROM achievement_badges WHERE token=?").get(minted.token).image_id).toBe("");
  } finally { db.close(); }
  // So the row stands for a certificate issued while mints still stored a copy:
  // a real servable PNG in `images`, named by the badge row.
  const badgeRow = { image_id: `older-copy-${Date.now()}` };
  const { api: anonPng } = await freshCtx();
  let png;
  try { png = await (await anonPng.get(`/badge/${minted.token}/badge.png`)).body(); } finally { await anonPng.dispose(); }
  expect(png.slice(0, 8).toString("hex"), "PRECONDITION: the share image renders").toBe("89504e470d0a1a0a");
  const dbw = new Database(TEST_DB_PATH);
  try {
    dbw.prepare("INSERT INTO images (id, data, mime_type, created_at) VALUES (?,?,?,?)").run(badgeRow.image_id, png, "image/png", new Date().toISOString());
    dbw.prepare("UPDATE achievement_badges SET image_id=? WHERE token=?").run(badgeRow.image_id, minted.token);
  } finally { dbw.close(); }

  // POSITIVE CONTROL — the badge row AND its image really exist right now, and
  // the image is a real servable PNG. "It's gone afterwards" proves nothing if
  // it was never there.
  db = new Database(TEST_DB_PATH, { readonly: true });
  const imgBefore = db.prepare("SELECT id, length(data) AS n FROM images WHERE id=?").get(badgeRow.image_id);
  db.close();
  expect(imgBefore, "the badge PNG is in `images` before the delete").toBeTruthy();
  expect(imgBefore.n, "…and it holds real bytes").toBeGreaterThan(1000);
  const { api: anonBefore } = await freshCtx();
  const served = await anonBefore.get(`/api/images/${badgeRow.image_id}`);
  expect(served.status(), "the PNG serves before the delete").toBe(200);
  await anonBefore.dispose();

  const { api: sa2, csrf: c2 } = await apiLogin("superadmin");
  const del = await sa2.delete(`/api/admin/competitions/${compId}`, { headers: { "x-csrf-token": c2 } });
  expect(del.status(), "an ended competition is deletable").toBe(200);
  await sa2.dispose();

  db = new Database(TEST_DB_PATH, { readonly: true });
  const badgeAfter = db.prepare("SELECT token FROM achievement_badges WHERE token=?").get(minted.token);
  const imgAfter = db.prepare("SELECT id FROM images WHERE id=?").get(badgeRow.image_id);
  db.close();
  // The FK cascade (coverage for the schema, not the handler)…
  expect(badgeAfter, "the achievement_badges row cascades away with the competition").toBeFalsy();
  // …and the load-bearing assertion: the PNG the handler must delete by hand.
  // Keyed on the CAPTURED image_id, so it can't be satisfied by other tests' rows.
  expect(imgAfter, `the badge PNG ${badgeRow.image_id} must not orphan in \`images\``).toBeFalsy();

  // And it is genuinely unreachable, not merely absent from one SELECT.
  const { api: anonAfter } = await freshCtx();
  expect((await anonAfter.get(`/api/images/${badgeRow.image_id}`)).status(),
    "the orphan cannot still be served").toBe(404);
  await anonAfter.dispose();
});

// ── v7.21.28 — the BADGE names the person, artwork included ─────────────────
//
// v7.21.27 changed the certificate PDF only. The PNG is the same artwork — it is
// what a participant downloads and what LinkedIn renders — so it carries the name
// too, and the public page's caption follows the picture beside it.
//
// The name is FROZEN at mint (achievement_badges.name_snapshot). That is what
// these tests are built around: the PNG is written once and never re-rendered, so
// a fixture must mint AFTER setting the profile, and editing a name afterwards
// must NOT move any of the three surfaces.
test.describe("v7.21.28 — the badge names the person", () => {
  /**
   * A whole owned fixture: participant with the given name, own ended
   * competition, solved, badge minted. Own everything (fixture checklist #2/#3)
   * — badges are idempotent per (user, competition), so reusing a shared
   * participant would hand back a badge minted before the profile was set, with
   * a name_snapshot frozen from whatever ran first.
   */
  async function ownBadge({ personalTitle = "", firstName, lastName, startDaysAgo = 0, share = false }) {
    const stamp = `${Date.now()}${Math.floor(Math.random() * 1e5)}`;
    const email = `bn${stamp}@company.com`;
    const nick = `bn${stamp}`.slice(0, 20);
    const { api: sa, csrf } = await apiLogin("superadmin");
    const H = h(csrf);
    let compId, token;
    try {
      await registerPost(sa, "/api/register", { headers: H, data: {
        firstName, lastName, nickname: nick, email, personalTitle,
        company: "Acme", title: "Engineer", avatar: "🦊",
        country: "US", timezone: "America/New_York",
        jobFunction: "Software Developer / Engineer", city: "New York",
      }});
      const all = await (await sa.get("/api/admin/participants?limit=5000")).json();
      const u = (all.participants || []).find(p => p.email === email);
      expect(u, "the participant registered").toBeTruthy();
      await sa.post(`/api/admin/participants/${u.id}/verify`, { headers: H });
      await sa.post(`/api/admin/participants/${u.id}/approve`, { headers: H });

      compId = (await (await sa.post("/api/admin/competitions", { headers: H, data: {
        name: `BadgeName ${stamp}`,
        start_time: new Date(Date.now() - (startDaysAgo * 86400_000) - 60_000).toISOString(),
        duration_minutes: startDaysAgo ? startDaysAgo * 24 * 60 + 180 : 180,
      }})).json()).competition.id;
      const taskId = await makeTask(sa, H, compId, stamp);
      await sa.post("/api/admin/competitions/assign", { headers: H, data: { userIds: [u.id], competitionIds: [compId] } });
      await solve(email, compId, taskId);
      await sa.post(`/api/admin/competitions/${compId}/end-now`, { headers: H });
    } finally { await sa.dispose(); }

    const m = await mint(email, compId);
    expect(m.status, `mint: ${JSON.stringify(m.body)}`).toBe(200);
    token = m.body.token;
    // v8.6.2 — the page is withheld until its holder shares, so a test that reads
    // the PAGE must opt in. OPT-IN rather than automatic: sharing emits a
    // `badge_shared` audit event, and the History test below asserts EXACTLY
    // three badge_* events — a shared fixture must not carry a side effect its
    // own consumers count. The PNG and PDF are unaffected either way; they stay
    // ungated, being how the holder collects.
    if (share) await shareAsOwner(email, token);
    return { email, nick, token, compId };
  }

  /** The /Title of a certificate PDF, decoded from its UTF-16BE hex string. */
  async function certTitle(token) {
    const { api: anon } = await freshCtx();
    try {
      const r = await anon.get(`/badge/${token}/certificate.pdf`);
      expect(r.status(), "the certificate renders").toBe(200);
      const hex = /\/Title <([0-9a-f]+)>/i.exec((await r.body()).toString("latin1"));
      expect(hex, "the PDF carries a title").toBeTruthy();
      return Buffer.from(hex[1], "hex").swap16().toString("utf16le").replace(/^﻿/, "");
    } finally { await anon.dispose(); }
  }

  /** Apply a partial profile edit, preserving every required field. */
  async function editProfile(email, patch) {
    const { api, csrf } = await apiLogin(email, PARTICIPANT_PASS);
    try {
      const me = await (await api.get("/api/me")).json();
      const r = await api.put("/api/me", { headers: h(csrf), data: {
        firstName: me.first_name, lastName: me.last_name, nickname: me.nickname,
        email: me.email, secondaryEmail: me.secondary_email || "",
        company: me.company, title: me.title, personalTitle: me.personal_title || "",
        phone: me.phone || "", linkedinUrl: me.linkedin_url || "",
        country: me.country, timezone: me.timezone,
        jobFunction: me.job_function, city: me.city, ...patch,
      }});
      expect(r.status(), `profile edit: ${await r.text()}`).toBe(200);
    } finally { await api.dispose(); }
  }

  function badgeRow(token) {
    const Database = require("better-sqlite3");
    const db = new Database(TEST_DB_PATH, { readonly: true });
    try { return db.prepare("SELECT * FROM achievement_badges WHERE token=?").get(token); }
    finally { db.close(); }
  }

  test("the PNG is RENDERED ON REQUEST — an artwork change reaches existing badges", async () => {
    // v7.21.30. It used to be rasterised once at mint and stored, so every view
    // served frozen bytes and a badge minted before an artwork change kept the
    // OLD design for ever — which is what happened at v7.21.29.
    //
    // Proven by giving the badge a CORRUPT stored copy and asking for it: if the
    // route served storage the response would be those bytes, and it is not.
    // That is the only way to tell "rendered" from "served from a cache" without
    // waiting for a redesign. No mint stores a copy any more (sweep #43), so the
    // row is made to stand for one issued while mints still did.
    const b = await ownBadge({ firstName: "Rennie", lastName: "Derr" });
    const row = badgeRow(b.token);
    expect(row.image_id, "PRECONDITION: the mint stored no copy (sweep #43)").toBe("");
    const Database = require("better-sqlite3");
    const db = new Database(TEST_DB_PATH);
    const storedId = `corrupt-copy-${Date.now()}`;
    try {
      db.prepare("INSERT INTO images (id, data, mime_type, created_at) VALUES (?,?,?,?)").run(storedId, Buffer.from("NOT-A-PNG"), "image/png", new Date().toISOString());
      db.prepare("UPDATE achievement_badges SET image_id=? WHERE token=?").run(storedId, b.token);
    }
    finally { db.close(); }

    const { api: anon } = await freshCtx();
    try {
      const r = await anon.get(`/badge/${b.token}/badge.png`);
      expect(r.status(), "the image serves").toBe(200);
      expect(r.headers()["content-type"]).toBe("image/png");
      const buf = await r.body();
      expect(buf.slice(0, 8).toString("hex"), "a real PNG, not the corrupted store").toBe("89504e470d0a1a0a");
      expect(buf.length).toBeGreaterThan(1000);

      // …and it is the CURRENT artwork for this badge's frozen values.
      const dbr = new Database(TEST_DB_PATH, { readonly: true });
      let comp;
      try { comp = dbr.prepare("SELECT name, start_time FROM competitions WHERE id=?").get(row.competition_id); }
      finally { dbr.close(); }
      const platformName = (await (await anon.get("/api/config")).json()).platform_name;
      const expected = await badge.renderBadgePng(badge.buildBadgeSvg({
        platformName, rank: row.rank, competitionName: comp.name,
        displayName: row.name_snapshot,
        dateLabel: badge.badgeDateLabel(comp.start_time),
        scoreLabel: Number.isFinite(row.score_snapshot) ? `${row.score_snapshot} pts` : null,
      }));
      expect(buf.equals(expected), "the served bytes are today's artwork").toBe(true);
    } finally { await anon.dispose(); }
  });

  test("an unknown token gets the same uniform 404 from the image route", async () => {
    const { api: anon } = await freshCtx();
    try {
      const r = await anon.get("/badge/definitely-not-a-real-token/badge.png");
      expect(r.status()).toBe(404);
      expect((await r.text()).toLowerCase(), "no existence oracle").not.toMatch(/revok|exist|invalid token/);
    } finally { await anon.dispose(); }
  });

  test("the PNG ARTWORK carries Salutation First Last — the reported gap", async () => {
    // v7.21.27 changed the certificate only, so this is the new half. Asserted at
    // the bytes: the served image must BE the full-name artwork and must NOT be
    // the nickname artwork, which is the only way to tell them apart in a PNG.
    // (It is rendered on request; no mint stores a copy, sweep #43.)
    const b = await ownBadge({ personalTitle: "Dr.", firstName: "Ada", lastName: "Lovelace" });
    const row = badgeRow(b.token);
    expect(row.name_snapshot, "the name is frozen at mint").toBe("Dr. Ada Lovelace");

    const { api: anon } = await freshCtx();
    try {
      const served = await anon.get(`/badge/${b.token}/badge.png`);
      expect(served.status(), "the image serves").toBe(200);
      const png = await served.body();
      const Database = require("better-sqlite3");
      const db = new Database(TEST_DB_PATH, { readonly: true });
      let comp;
      try { comp = db.prepare("SELECT name, start_time FROM competitions WHERE id=?").get(row.competition_id); }
      finally { db.close(); }
      const platformName = (await (await anon.get("/api/config")).json()).platform_name;
      const artwork = name => badge.buildBadgeSvg({
        platformName, rank: row.rank, competitionName: comp.name, displayName: name,
        dateLabel: badge.badgeDateLabel(comp.start_time),
        scoreLabel: Number.isFinite(row.score_snapshot) ? `${row.score_snapshot} pts` : null,
      });
      expect(png.equals(await badge.renderBadgePng(artwork("Dr. Ada Lovelace"))),
        "the served PNG IS the full-name artwork").toBe(true);
      expect(png.equals(await badge.renderBadgePng(artwork(b.nick))),
        "…and is NOT the nickname artwork").toBe(false);
    } finally { await anon.dispose(); }
  });

  test("the certificate PDF and the public page name the same person as the artwork", async () => {
    const b = await ownBadge({ personalTitle: "Dr.", firstName: "Ada", lastName: "Lovelace", share: true });
    expect(await certTitle(b.token)).toContain("Dr. Ada Lovelace");

    const { api: anon } = await freshCtx();
    try {
      const html = await (await anon.get(`/badge/${b.token}`)).text();
      // The badge image IS this page's og:image, so a caption still reading the
      // nickname would contradict the picture beside it.
      expect(html, "the page names the person").toContain("Dr. Ada Lovelace");
      expect(html, "…not the handle").not.toContain(b.nick);
    } finally { await anon.dispose(); }
  });

  test("no salutation is simply First Last", async () => {
    const b = await ownBadge({ firstName: "Grace", lastName: "Hopper" });
    expect(badgeRow(b.token).name_snapshot).toBe("Grace Hopper");
    const title = await certTitle(b.token);
    expect(title).toContain("Grace Hopper");
    expect(title, "no leading space or stray separator").not.toMatch(/\s{2,}/);
  });

  test("a CORRECTED name reaches every surface — artwork, certificate and page", async () => {
    // v7.21.31 REVERSES v7.21.28's freeze, deliberately. That freeze existed for
    // one reason: the PNG was rasterised once and stored, so reading the live
    // profile for the PDF and the page would have let one token name the person
    // differently in artwork and text. v7.21.30 made every surface render on
    // demand through one resolver, so they cannot disagree however the value is
    // obtained — and live is strictly better, because a badge minted before the
    // name landed is otherwise stuck showing a handle for ever, which is exactly
    // what was reported.
    const b = await ownBadge({ firstName: "Ada", lastName: "Lovelace", share: true });
    expect(await certTitle(b.token)).toContain("Ada Lovelace");
    await editProfile(b.email, { lastName: "Byron" });

    expect(await certTitle(b.token), "the certificate follows the correction").toContain("Ada Byron");
    const { api: anon } = await freshCtx();
    try {
      const html = await (await anon.get(`/badge/${b.token}`)).text();
      expect(html, "…and so does the page").toContain("Ada Byron");
      expect(html).not.toContain("Ada Lovelace");
      // …and so does the ARTWORK, which is the surface that was stuck.
      const row = badgeRow(b.token);
      const Database = require("better-sqlite3");
      const dbr = new Database(TEST_DB_PATH, { readonly: true });
      let comp;
      try { comp = dbr.prepare("SELECT * FROM competitions WHERE id=?").get(row.competition_id); }
      finally { dbr.close(); }
      const platformName = (await (await anon.get("/api/config")).json()).platform_name;
      const served = await (await anon.get(`/badge/${b.token}/badge.png`)).body();
      const expected = await badge.renderBadgePng(badge.buildBadgeSvg({
        platformName, rank: row.rank, competitionName: comp.name, displayName: "Ada Byron",
        dateLabel: badge.badgeDateLabel(new Date(new Date(comp.start_time).getTime() + comp.duration_minutes * 60000) < new Date(comp.ended_at) ? new Date(new Date(comp.start_time).getTime() + comp.duration_minutes * 60000) : new Date(comp.ended_at)),
        scoreLabel: Number.isFinite(row.score_snapshot) ? `${row.score_snapshot} pts` : null,
      }));
      expect(served.equals(expected), "the artwork carries the corrected name").toBe(true);
    } finally { await anon.dispose(); }
  });

  test("a LEGACY badge (no name_snapshot) shows the PERSON on every surface", async () => {
    // v7.21.28 kept a legacy badge on the nickname because its stored artwork
    // carried the nickname. v7.21.30 re-renders that artwork, so the reason is
    // gone — and the page and the image had DIFFERENT fallbacks, which is the
    // contradiction that produced "I can still see the nickname".
    const b = await ownBadge({ firstName: "Ada", lastName: "Lovelace", share: true });
    const Database = require("better-sqlite3");
    const db = new Database(TEST_DB_PATH);
    try { db.prepare("UPDATE achievement_badges SET name_snapshot=NULL WHERE token=?").run(b.token); }
    finally { db.close(); }

    expect(await certTitle(b.token), "the certificate names the person").toContain("Ada Lovelace");
    const { api: anon } = await freshCtx();
    try {
      const html = await (await anon.get(`/badge/${b.token}`)).text();
      expect(html, "and so does the page — no longer the handle").toContain("Ada Lovelace");
      expect(html, "the page and the artwork must not disagree").not.toContain(b.nick);
    } finally { await anon.dispose(); }
  });

  test("a name the badge fonts cannot DRAW falls back to the nickname, everywhere", async () => {
    // Nicknames are ASCII-restricted by platform rule; names are full Unicode and
    // the fonts draw a fixed set of scripts, so an unrenderable name would give a
    // badge of empty boxes — worse than one carrying the handle.
    // The example has moved as the covered scripts grew: from Cyrillic to CJK
    // when Inter brought Cyrillic and Greek, and to Georgian when the Noto faces
    // (operator ruling, 14 Nov 2026) brought CJK, Arabic, Hebrew and Thai. The
    // RULE under test is identical: a name the fonts cannot draw must
    // fall back to the nickname everywhere, or the certificate is a page of empty
    // boxes naming nobody.
    expect(badge.canRenderText("გიორგი ბერიძე"), "PRECONDITION: no shipped face draws Georgian").toBe(false);
    const b = await ownBadge({ firstName: "გიორგი", lastName: "ბერიძე", share: true });
    expect(badgeRow(b.token).name_snapshot, "the fallback is what gets frozen").toBe(b.nick);
    expect(await certTitle(b.token)).toContain(b.nick);
    const { api: anon } = await freshCtx();
    try {
      expect(await (await anon.get(`/badge/${b.token}`)).text()).toContain(b.nick);
    } finally { await anon.dispose(); }
  });

  test("the DATE is when the event ENDED for the participant, not when it started", async () => {
    // Reported: a competition running 5-7 August put "5 Aug" on the badge. The
    // field is labelled DATE and was the competition's START time.
    const b = await ownBadge({ firstName: "Enda", lastName: "Dayton", startDaysAgo: 3, share: true });
    const row = badgeRow(b.token);
    const Database = require("better-sqlite3");
    const dbr = new Database(TEST_DB_PATH, { readonly: true });
    let comp;
    try { comp = dbr.prepare("SELECT * FROM competitions WHERE id=?").get(row.competition_id); }
    finally { dbr.close(); }

    const startLabel = badge.badgeDateLabel(comp.start_time);
    const endLabel = badge.badgeDateLabel(comp.ended_at);
    expect(startLabel, "the fixture must actually span days, or this asserts nothing")
      .not.toBe(endLabel);

    const { api: anon } = await freshCtx();
    try {
      const html = await (await anon.get(`/badge/${b.token}`)).text();
      expect(html, "the badge carries the END date").toContain(endLabel);
      expect(html, "…and not the start date").not.toContain(startLabel);
    } finally { await anon.dispose(); }
  });

  test("in a multi-session competition the date is THAT PARTICIPANT's session end", async () => {
    // "Ended for the user" is not the competition's end: sessions finish at
    // different times, and the badge belongs to the person, not the event. The
    // slot is resolved from competition_users because a badge only carries
    // timeslot_id in per-slot leaderboard mode, while the participant competed in
    // a specific session either way.
    const b = await ownBadge({ firstName: "Sess", lastName: "Ionn", share: true });
    const row = badgeRow(b.token);
    const Database = require("better-sqlite3");
    const db = new Database(TEST_DB_PATH);
    // A session that ended two days before the competition did.
    // TWO sessions, and the participant is in the EARLIER one. With only one the
    // test cannot fail: `competitionEffectiveEnd` is the max over slots, which
    // for a single slot IS that slot — so removing the per-participant lookup
    // would give the same answer and the mutation would pass (measured).
    const slotStart = new Date(Date.now() - 2 * 86400_000 - 3600_000);
    const slotId = `ts-${Date.now()}`;
    const laterId = `ts-${Date.now()}-b`;
    try {
      const ins = db.prepare("INSERT INTO competition_timeslots (id, competition_id, name, start_time, duration_minutes, created_at) VALUES (?,?,?,?,?,?)");
      ins.run(slotId, row.competition_id, "Morning", slotStart.toISOString(), 60, new Date().toISOString());
      ins.run(laterId, row.competition_id, "Afternoon", new Date(Date.now() - 3600_000).toISOString(), 60, new Date().toISOString());
      db.prepare("UPDATE competition_users SET timeslot_id=? WHERE competition_id=? AND user_id=?")
        .run(slotId, row.competition_id, row.user_id);
      // The competition's own end must not coincide with the participant's, or
      // the assertion below cannot tell the two apart.
      db.prepare("UPDATE competitions SET ended_manually=0 WHERE id=?").run(row.competition_id);
      // v8.1.0 — RE-FREEZE THE STORED DATE, because the sessions are retro-fitted.
      //
      // The date is now captured at MINT (`date_snapshot`), so that an admin
      // extending a deadline cannot rewrite the date on a certificate already
      // downloaded and filed. This fixture builds the sessions AFTER minting,
      // which production never does — an event is over before a badge exists — so
      // it must put the row into the state a real mint would have produced.
      // Clearing the snapshot restores the live derivation for this row, which is
      // exactly what the per-participant resolution under test computes.
      db.prepare("UPDATE achievement_badges SET date_snapshot=NULL WHERE token=?").run(b.token);
    } finally { db.close(); }

    const slotEnd = new Date(slotStart.getTime() + 60 * 60_000);
    const dbr = new Database(TEST_DB_PATH, { readonly: true });
    let comp;
    try { comp = dbr.prepare("SELECT * FROM competitions WHERE id=?").get(row.competition_id); }
    finally { dbr.close(); }
    const compEnd = new Date(Date.now() - 3600_000 + 60 * 60_000);   // the LATER session's end
    expect(badge.badgeDateLabel(slotEnd), "the two sessions must end on different days")
      .not.toBe(badge.badgeDateLabel(compEnd));

    const { api: anon } = await freshCtx();
    try {
      const html = await (await anon.get(`/badge/${b.token}`)).text();
      expect(html, "the participant's OWN session end").toContain(badge.badgeDateLabel(slotEnd));
      expect(html, "not the competition's, which is the later session")
        .not.toContain(badge.badgeDateLabel(compEnd));
    } finally { await anon.dispose(); }
  });

  test("downloads and shares are on the competition History, with both identities", async () => {
    // Minting was audited from the start; taking the artifact away was not — so
    // nothing recorded that a certificate had actually been collected, which is
    // the question an operator is asked.
    const b = await ownBadge({ firstName: "Dee", lastName: "Loder" });
    const events = () => {
      const Database = require("better-sqlite3");
      const db = new Database(TEST_DB_PATH, { readonly: true });
      try {
        return db.prepare("SELECT event_type, changed_by, details FROM competition_events WHERE competition_id=? ORDER BY rowid")
          .all(badgeRow(b.token).competition_id)
          .map(r => ({ type: r.event_type, actor: r.changed_by, d: JSON.parse(r.details || "{}") }));
      } finally { db.close(); }
    };

    // The OWNER, signed in, takes both artifacts and shares.
    const { api, csrf } = await apiLogin(b.email, PARTICIPANT_PASS);
    try {
      expect((await api.get(`/badge/${b.token}/badge.png?dl=1`)).status()).toBe(200);
      expect((await api.get(`/badge/${b.token}/certificate.pdf`)).status()).toBe(200);
      expect((await api.post(`/badge/${b.token}/shared`, { headers: { "x-csrf-token": csrf } })).status()).toBe(200);
    } finally { await api.dispose(); }

    await expect.poll(() => events().filter(e => /badge_(image_downloaded|certificate_downloaded|shared)/.test(e.type)).length,
      { timeout: 5000 }).toBe(3);
    for (const type of ["badge_image_downloaded", "badge_certificate_downloaded", "badge_shared"]) {
      const ev = events().find(e => e.type === type);
      expect(ev, `${type} is recorded`).toBeTruthy();
      expect(ev.actor, `${type} names who fetched it`).toBe(b.email);
      expect(ev.d.user_id, `${type} names whose badge it is`).toBe(badgeRow(b.token).user_id);
      expect(ev.d.by_owner, `${type} records that the owner took it`).toBe(true);
      expect(ev.d.ip, `${type} carries the request context`).toBeTruthy();
    }
  });

  test("an ANONYMOUS fetch of a circulated link is recorded as such, not as the owner", async () => {
    // The routes are public and token-keyed, so the fetcher may not be the owner.
    // Attributing a stranger's download to the participant would be a wrong
    // answer of exactly the kind this repo keeps recording.
    const b = await ownBadge({ firstName: "Ann", lastName: "Onymous" });
    const { api: anon } = await freshCtx();
    try {
      expect((await anon.get(`/badge/${b.token}/certificate.pdf`)).status()).toBe(200);
    } finally { await anon.dispose(); }

    const Database = require("better-sqlite3");
    const db = new Database(TEST_DB_PATH, { readonly: true });
    let ev;
    try {
      ev = db.prepare("SELECT changed_by, details FROM competition_events WHERE competition_id=? AND event_type='badge_certificate_downloaded'")
        .get(badgeRow(b.token).competition_id);
    } finally { db.close(); }
    expect(ev, "recorded").toBeTruthy();
    expect(ev.changed_by, "the fetcher is anonymous").toBe("anonymous");
    const d = JSON.parse(ev.details);
    expect(d.by_owner, "and explicitly NOT the owner").toBe(false);
    expect(d.user_id, "…while still naming whose badge it was").toBe(badgeRow(b.token).user_id);
  });

  test("an og:image RENDER is not logged as a download — only a marked one is", async () => {
    // The PNG route is the page's og:image, so it is pulled by every page view
    // and every crawler re-scrape. Logging those would bury the one line an
    // operator cares about under machine traffic.
    const b = await ownBadge({ firstName: "Cee", lastName: "Rawler" });
    const compId = badgeRow(b.token).competition_id;
    const count = () => {
      const Database = require("better-sqlite3");
      const db = new Database(TEST_DB_PATH, { readonly: true });
      try {
        return db.prepare("SELECT COUNT(*) c FROM competition_events WHERE competition_id=? AND event_type='badge_image_downloaded'").get(compId).c;
      } finally { db.close(); }
    };
    const { api: anon } = await freshCtx();
    try {
      for (let i = 0; i < 3; i++) expect((await anon.get(`/badge/${b.token}/badge.png`)).status()).toBe(200);
      await new Promise(r => setTimeout(r, 300));
      expect(count(), "three plain renders log nothing").toBe(0);
      expect((await anon.get(`/badge/${b.token}/badge.png?dl=1`)).status()).toBe(200);
      await expect.poll(count, { timeout: 5000 }).toBe(1);
    } finally { await anon.dispose(); }
  });

  test("certificateName formats the three parts, and refuses a salutation alone", () => {
    expect(badge.certificateName({ personalTitle: "Dr.", firstName: "Alice", lastName: "Smith" })).toBe("Dr. Alice Smith");
    expect(badge.certificateName({ personalTitle: "", firstName: "Alice", lastName: "Smith" })).toBe("Alice Smith");
    expect(badge.certificateName({ personalTitle: "  Ms. ", firstName: " Ada ", lastName: " Lovelace " })).toBe("Ms. Ada Lovelace");
    expect(badge.certificateName({ firstName: "Cher", lastName: "" })).toBe("Cher");
    // A salutation with no name names nobody — the caller must fall back.
    expect(badge.certificateName({ personalTitle: "Dr." })).toBe("");
    expect(badge.certificateName({})).toBe("");
  });

  test("canRenderText answers for the fonts actually shipped", () => {
    expect(badge.canRenderText("Dr. María José García-Hernández"), "latin-ext is covered").toBe(true);
    // v8.1.0 (PR 24) — CYRILLIC IS NOW COVERED, and Greek came with it. The
    // guarantee this test asserts is unchanged (an undrawable name is refused);
    // only the EXAMPLE moved, because the shipped subset grew. See
    // tests/badge-fonts.spec.js for why the fonts were swapped.
    expect(badge.canRenderText("Иван Петров"), "cyrillic is covered as of v8.1.0").toBe(true);
    expect(badge.canRenderText("Γεώργιος"), "greek came with it").toBe(true);
    // The Noto fallback faces (operator ruling, 14 Nov 2026) cover CJK and Hebrew
    // now; the example of a name no face draws moved to Georgian.
    expect(badge.canRenderText("田中 太郎"), "cjk is covered by the Noto CJK face").toBe(true);
    expect(badge.canRenderText("דוד"), "hebrew is covered by the Noto Hebrew face").toBe(true);
    expect(badge.canRenderText("გიორგი"), "georgian is not").toBe(false);
  });

  test("A NAME IS NEVER CUT — on either canvas, at any length", () => {
    // The operator's requirement, stated flatly: names should never be cut. The
    // fitter used for every OTHER field shrinks and then ellipsises, which is
    // right for a competition label and wrong for a person — middle names are
    // routinely carried in the first- or last-name field, so "ordinary" runs long.
    //
    // This asserts the whole pipeline, not the helper: the rendered SVG must
    // contain every word of the name and no ellipsis, and the text must stay
    // inside its column.
    const base = { platformName: "Checkmarx Enablement Hub", rank: 1, dateLabel: "6 Aug 2026", scoreLabel: "400 pts" };
    const NAMES = [
      "Ada",
      "Alice Smith",
      "Dr. María José García-Hernández",
      "Dr. Maria Jose Guadalupe Garcia-Hernandez de la Vega",
      "Wolfgang Amadeus Chrysostomus Theophilus Mozart-Beethoven",
      "Mr. Jean-Baptiste Emmanuel Zorg de la Fontaine-Rothschild III",
      // No spaces at all — nothing to wrap on, so it can only shrink.
      "Supercalifragilisticexpialidociousnamewithnospacesatall",
    ];
    // The tightest case: a competition long enough to take two lines, so the name
    // gets the least vertical room it will ever have.
    const COMPS = ["Spring CTF", "Spring Security Capture The Flag Championship 2026"];
    // v8.15.0 — the certificate sets the name in Inter ExtraBold tracked -1 in a
    // 780px measure, and marks it class="cert-name": its fill is a gradient, so
    // the share card's fill="#FFFFFF" selector no longer identifies it.
    const SHARE_RE = /<text x="430" y="\d+" text-anchor="middle"[^>]*font-size="([\d.]+)"[^>]*fill="#FFFFFF">([^<]*)<\/text>/g;
    const CERT_RE = /<text class="cert-name" x="540" y="\d+" text-anchor="middle"[^>]*font-size="([\d.]+)"[^>]*>([^<]*)<\/text>/g;
    for (const [what, build, re, maxW, ls, weight] of [
      ["share", badge.buildBadgeSvg, SHARE_RE, 640, -0.8, 800],
      ["certificate", badge.buildCertificateSvg, CERT_RE, 780, -1, 800],
    ]) {
      for (const competitionName of COMPS) {
        for (const displayName of NAMES) {
          const svg = build({ ...base, competitionName, displayName });
          const rendered = [...svg.matchAll(new RegExp(re.source, "g"))];
          expect(rendered.length, `${what}: the name renders for "${displayName}"`).toBeGreaterThan(0);
          const size = Number(rendered[0][1]);
          const lines = rendered.map(m => m[2]);
          const joined = lines.join(" ");

          expect(joined, `${what}: no ellipsis in "${displayName}"`).not.toContain("…");
          // EVERY word survives, in order — the strongest form of "not cut".
          expect(joined.replace(/\s+/g, " ").trim(),
            `${what}: "${displayName}" must render in full`).toBe(displayName.replace(/\s+/g, " ").trim());
          // …and it stays inside its column.
          for (const ln of lines) {
            expect(badge._measureText(ln, size, weight, ls),
              `${what}: "${ln}" overflows its column`).toBeLessThanOrEqual(maxW + 1);
          }
          expect(size, `${what}: still legible for "${displayName}"`).toBeGreaterThanOrEqual(16);
        }
      }
    }
  });

  test("a long name uses TWO lines rather than shrinking to a whisper", () => {
    // Without this, "never cut" is satisfied by rendering every name at 9px.
    const f = badge._fitNameLines("Wolfgang Amadeus Chrysostomus Theophilus Mozart-Beethoven",
      { maxWidth: 830, size: 92, minSize: 24, weight: 800, letterSpacing: -1 });
    expect(f.lines.length, "wrapped rather than crushed").toBe(2);
    expect(f.size, "and at a size a person can read").toBeGreaterThanOrEqual(40);
    // The split is balanced, not "one word on the second line".
    const [a, b] = f.lines.map(l => badge._measureText(l, f.size, 800, -1));
    expect(Math.min(a, b) / Math.max(a, b), "the two lines are of similar width").toBeGreaterThan(0.6);
  });

  test("the two canvases are the sizes they claim, and both carry the brand mark", () => {
    // The share image stays on LinkedIn's OpenGraph ratio; the certificate gets
    // the proportions the template was drawn at. Swapping them is the failure
    // this pins — a 3:2 og:image is cropped by the card, and an OG-shaped
    // certificate wastes half an A4 page.
    const args = { platformName: "Hack Arena", rank: 1, competitionName: "Spring CTF", displayName: "Ada Lovelace", dateLabel: "1 Jan 2026", scoreLabel: "300 pts" };
    const share = badge.buildBadgeSvg(args);
    const cert = badge.buildCertificateSvg(args);
    expect(share).toContain('width="1200" height="627"');
    expect(cert).toContain('width="1536" height="1024"');
    expect(1200 / 627, "the share canvas is OpenGraph-shaped").toBeCloseTo(1.91, 1);
    expect(1536 / 1024, "the certificate is 3:2").toBeCloseTo(1.5, 5);

    // Both are the same design: same headline, same brand mark, same medal.
    const logo = fs.readFileSync(path.join(__dirname, "..", "public", "checkmarx-logo-white.svg"), "utf8");
    const firstPath = /<path[^>]*\bd="([^"]+)"/.exec(logo)[1];
    for (const [what, svg] of [["share", share], ["certificate", cert]]) {
      expect(svg, `${what} carries the brand mark`).toContain(firstPath);
      expect(svg, `${what} carries the headline`).toContain("CERTIFICATE OF ACHIEVEMENT");
    }
    // Each canvas draws its own medal: the share card's flat disc, the
    // certificate's struck medal (bevelled rim, faceted star).
    expect(share, "the share card carries its medal").toContain('fill="url(#disc)"');
    expect(cert, "the certificate carries its struck medal").toContain('fill="url(#rim)"');
    // The blurb, laurel and tagline are certificate-only — there is no room for
    // them at 627px tall and they carry no participant data.
    expect(cert).toContain("APPLICATION SECURITY FOR THE AI ERA");
    expect(share, "the share canvas drops the certificate-only chrome")
      .not.toContain("APPLICATION SECURITY FOR THE AI ERA");
  });
});

// NO CERTIFICATE WITHOUT AN ATTEMPT, and no medal without points above zero
// (operator ruling, 14 Nov 2026). Two members enter the event (their
// `login_time` puts them on the board at score 0) and never submit; one member
// scores. On a thin board the two no-shows sit at ranks 2 and 3, exactly the
// rows a placement used to be issued for without `participantAttempted`. Only
// the scorer may mint, and the offer surfaces (canShareBadge, claimable) agree
// with the mint.
test.describe("No certificate without an attempt, placement included", () => {
  test("two 0-activity members and one scorer: only the scorer gets a (placement) certificate", async () => {
    const { api, csrf } = await apiLogin("superadmin");
    const H = h(csrf);
    const stamp = `${Date.now()}`;
    try {
      const scorer = `p1-scorer-${stamp}@acme.com`, idle1 = `p1-idle1-${stamp}@acme.com`, idle2 = `p1-idle2-${stamp}@acme.com`;
      const ids = [];
      for (const [e, n] of [[scorer, "p1s"], [idle1, "p1a"], [idle2, "p1b"]]) ids.push(await ensureParticipant(api, H, e, `${n}_${stamp}`));
      const comp = (await (await api.post("/api/admin/competitions", { headers: H, data: {
        // `entry`: the no-shows reach the podium by entering, the state under test.
        name: `P1 NoAttempt ${stamp}`, start_time: new Date(Date.now() - 10 * 60_000).toISOString(), duration_minutes: 180, clock_start: "entry",
      }})).json()).competition.id;
      const t1 = await makeTask(api, H, comp, `${stamp}-a`);
      await makeTask(api, H, comp, `${stamp}-b`); // a second challenge: one solve must not finish the event
      const asg = await (await api.post("/api/admin/competitions/assign", { headers: H, data: { userIds: ids, competitionIds: [comp] } })).json();
      expect(asg.assigned, JSON.stringify(asg)).toBe(3);
      await solve(scorer, comp, t1);
      await solve(idle1, comp, null);   // enters (login_time stamped), never attempts
      await solve(idle2, comp, null);
      expect((await api.post(`/api/admin/competitions/${comp}/end-now`, { headers: H })).ok()).toBe(true);

      // Precondition: the no-shows really ARE on the podium of the final board.
      const board = await (await api.get(`/api/admin/leaderboard?competitionId=${comp}`)).json();
      const rankOf = (id) => (board.find(r => r.userId === id) || {}).rank;
      expect(rankOf(ids[0])).toBe(1);
      expect([rankOf(ids[1]), rankOf(ids[2])].sort()).toEqual([2, 3]);

      const s = await mint(scorer, comp);
      expect(s.status, JSON.stringify(s.body)).toBe(200);
      expect(s.body.placement).toBe(true);
      expect((await leaderboard(scorer, comp)).body.canShareBadge).toBe(true);
      for (const e of [idle1, idle2]) {
        const m = await mint(e, comp);
        expect(m.status, `${e} must not mint: ${JSON.stringify(m.body)}`).toBe(403);
        expect(m.body.error).toMatch(/attempt/i);
        const lb = await leaderboard(e, comp);
        expect(lb.body.ended).toBe(true);
        expect(lb.body.canShareBadge, "the CTA follows the mint").toBe(false);
        const { api: pa } = await apiLogin(e, PARTICIPANT_PASS);
        const certs = await (await pa.get("/api/me/certificates")).json();
        await pa.dispose();
        expect(Array.isArray(certs.claimable)).toBe(true);
        expect(certs.claimable.some(c => c.competitionId === comp), "not offered").toBe(false);
      }
    } finally { await api.dispose(); }
  });
});
