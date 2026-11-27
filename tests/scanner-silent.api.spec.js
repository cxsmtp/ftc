// @ts-check
//
// v7.25.0 — an obvious scanner is blocked WITHOUT telling anybody.
//
// Reported from a live competition: a superadmin was emailed because an address
// had been blocked, and the address was unmistakably a scanner — it fished for
// /.env, /wp-admin, /phpmyadmin and collected a pile of 404s on its way to the
// 100-rejected-requests threshold. There was no decision for an admin to make,
// so the email and the modal were pure noise. A VENUE behind one NAT address
// looks superficially similar and is the entire reason the alert exists, so the
// fix is to tell the two apart rather than to quieten the alert.
//
// THE POSITIVE CONTROL IS THE POINT OF THIS FILE. "No alert was raised" is
// equally satisfied by an alert subsystem that is simply broken — the v7.16.6
// lesson, from this same subsystem: when two mechanisms produce the same
// user-visible outcome, an outcome assertion cannot tell you which one ran. So
// the cohort case is driven through the SAME running server, in the same file,
// and must still alert.
//
// HOW THE TRACKER IS REACHED AT ALL. The shared harness sets
// RATE_LIMIT_DISABLED=1, which short-circuits both scanner middlewares before
// they count or block. `POST /api/test/scanner-toggle` forces the tracker back
// on for this file WITHOUT arming the per-endpoint limiters (which is what
// reusing the rate-limit toggle would do, and would change behaviour for every
// other spec that touches it).
//
// AND THE afterEach IS LOAD-BEARING, not tidiness. A block on 127.0.0.1 lasts
// 15 minutes and 429s every later non-admin request in this file, surfacing as
// bare 429s that name nothing — the v7.16.8 failure that cost 27 CI tests.
// Draining at the START of the next test would always let the LAST test escape.
const { test, expect } = require("./isolated-test");
const { apiLogin, freshCtx, BASE } = require("./helpers");
const classify = require("../lib/scanner-classify");
// v8.3.20 — the alert COPY is asserted alongside the classifier, because the
// "mixed" sentence branches on a counter the classifier produces.
//
// The require is safe for the reason that MATTERS — no `db`, so it cannot open a
// second database (the v7.21.14 rule) — but not for the reason a first draft
// gave. It is NOT fs-free: `lib/admin-alerts` pulls `lib/log`, which at REQUIRE
// time mkdirs LOG_DIR, opens a rotating write stream and REPLACES
// console.log/warn/error. With no DATA_DIR set for the Playwright worker that
// resolves to the repo's own ./data/logs. Pre-existing and shared with every
// other spec that requires a lib/ module, so it is stated rather than worked
// around; the durable fix would be to pin DATA_DIR for the worker.
const alerts = require("../lib/admin-alerts");

test.use({ baseURL: BASE });

// Paths a real scanner walks. Every one is an UNROUTED 404 here (the platform
// has no server-side scripting and no catch-all route) and matches a known-bad
// signature, which is what the classifier requires as positive evidence.
const PROBE_PATHS = [
  "/.env", "/wp-admin/setup-config.php", "/phpmyadmin/index.php", "/.git/config",
  "/config.json", "/administrator/index.php", "/.aws/credentials", "/backup.sql",
  "/adminer.php", "/owa/auth/logon.aspx", "/actuator/env", "/cgi-bin/test.cgi",
];

async function armTracker(anon) {
  const r = await anon.post("/api/test/scanner-toggle", { data: { enable: true } });
  expect(r.ok(), "the scanner tracker can be armed for this file").toBe(true);
}
async function disarm(anon) {
  await anon.post("/api/test/scanner-toggle", { data: { enable: false } }).catch(() => {});
  await anon.post("/api/test/scanner-reset", {}).catch(() => {});
  await anon.post("/api/test/clear-ip-ban-alerts", {}).catch(() => {});
}
const state = async (anon) => (await (await anon.get("/api/test/scanner-state?ip=127.0.0.1")).json());

test.describe("A scanner is blocked silently; a venue is not (v7.25.0)", () => {
  test.beforeEach(async () => {
    const { api: anon } = await freshCtx();
    try { await disarm(anon); await armTracker(anon); } finally { await anon.dispose(); }
  });
  test.afterEach(async () => {
    const { api: anon } = await freshCtx();
    try { await disarm(anon); } finally { await anon.dispose(); }
  });

  test("probe traffic is blocked EARLY and raises no alert; venue-shaped traffic still alerts", async () => {
    const { api: anon } = await freshCtx();
    const { api: admin } = await apiLogin("superadmin");
    try {
      // ── the scanner ────────────────────────────────────────────────────────
      let blockedAt = 0;
      for (let i = 1; i <= 60 && !blockedAt; i++) {
        const r = await anon.get(PROBE_PATHS[i % PROBE_PATHS.length] + "?i=" + i);
        if (r.status() === 429) blockedAt = i;
      }
      expect(blockedAt, "the prober is blocked").toBeGreaterThan(0);
      expect(blockedAt,
        `blocked at request ${blockedAt} — a clear prober must not need the full 100-4xx run`
      ).toBeLessThan(40);

      const st = await state(anon);
      expect(st.verdict).toBe("probe");
      expect(st.silent).toBe(true);
      expect(st.threshold_kind).toBe("probe_early");
      expect(st.routed_4xx, "no real endpoint of the platform answered any of it").toBe(0);
      // The block covers the WHOLE address, not just the paths that tripped it.
      const blocked = await anon.get("/api/config");
      expect(blocked.status()).toBe(429);
      // …and says so by a code the browser acts on (public/js/core/api.js sends
      // nothing until Retry-After), which a rate limiter's 429 does not carry.
      expect(await blocked.json()).toMatchObject({ code: "address_blocked" });
      expect(Number(blocked.headers()["retry-after"])).toBeGreaterThan(0);

      // …and nobody was told. Read from an admin session, which is exempt from
      // the block, so this is a real read rather than a refused one.
      const alerts = await (await admin.get("/api/admin/alerts")).json();
      expect((alerts.alerts || []).length, "a probe-classified block raises no operator alert").toBe(0);

      // ── the positive control, same server, same test ───────────────────────
      // Without this everything above is satisfied by an alert subsystem that
      // has simply stopped working.
      await anon.post("/api/test/scanner-reset", {});
      let venueBlockedAt = 0;
      for (let i = 1; i <= 140 && !venueBlockedAt; i++) {
        // Unauthenticated admin reads: ROUTED 401s. This is realistic as well
        // as convenient — a roomful of expired sessions polling produces
        // exactly this shape, and it is what the two existing e2e cascades in
        // ip-ban-alerts / trusted-networks-e2e drive.
        if ((await anon.get("/api/admin/participants")).status() === 429) venueBlockedAt = i;
      }
      expect(venueBlockedAt, "the venue-shaped address is blocked too").toBeGreaterThan(0);
      const vst = await state(anon);
      expect(vst.verdict).toBe("cohort");
      expect(vst.silent).toBe(false);
      expect(vst.threshold_kind, "and it waits for the ordinary threshold").toBe("standard");

      await expect.poll(async () => {
        const a = await (await admin.get("/api/admin/alerts")).json();
        return (a.alerts || []).length;
      }, { timeout: 6000, intervals: [100, 200, 400, 800] })
        .toBeGreaterThan(0);
    } finally {
      await admin.dispose(); await anon.dispose();
    }
  });

  test("a silent block is still RECORDED — it is invisible to nobody but the alert", async () => {
    // The whole deal. If silence also meant no log line and no audit event, the
    // operator would have traded a noisy email for an outage they cannot
    // reconstruct afterwards.
    const { api: anon } = await freshCtx();
    const { api: admin } = await apiLogin("superadmin");
    try {
      for (let i = 1; i <= 40; i++) await anon.get(PROBE_PATHS[i % PROBE_PATHS.length] + "?j=" + i);
      expect((await state(anon)).silent).toBe(true);

      // The app.jsonl mirror is setImmediate-deferred by design, so poll.
      const row = await expect.poll(async () => {
        const d = await (await admin.get("/api/admin/logs?stream=app&limit=200&q=scanner_blocked")).json();
        return (d.entries || []).find(e => e.event_type === "scanner_blocked") || null;
      }, { timeout: 8000, intervals: [150, 300, 600, 1000] }).not.toBeNull().then(async () => {
        const d = await (await admin.get("/api/admin/logs?stream=app&limit=200&q=scanner_blocked")).json();
        return (d.entries || []).find(e => e.event_type === "scanner_blocked");
      });

      const det = typeof row.details === "string" ? JSON.parse(row.details) : row.details;
      expect(det.verdict).toBe("probe");
      expect(det.silent).toBe(true);
      expect(det.probe_4xx).toBeGreaterThan(0);
      expect(det.signature_distinct_paths).toBeGreaterThanOrEqual(3);
      expect(Array.isArray(det.sample_paths)).toBe(true);
      expect(det.sample_paths.length).toBeGreaterThan(0);

      // …and the warn-level line an operator sorting the Logs tab by level
      // would actually find.
      const warns = await (await admin.get("/api/admin/logs?stream=app&limit=200&q=Scanner%20detected")).json();
      expect((warns.entries || []).some(e => e.level === "warn" && /no alert raised/i.test(e.msg || "")),
        "the silent block still logs at warn, and says it was silent").toBe(true);
    } finally { await admin.dispose(); await anon.dispose(); }
  });

  test("a capability-bearing path is scrubbed before it is ever stored", async () => {
    // POST /join/<token> is the one input that is both COUNTED and secret:
    // the SPA-shell middleware only serves GET/HEAD, so a POST falls through to
    // an unrouted 404 and would otherwise put a live 256-bit self-enroll secret
    // into an audit event and into app.jsonl.
    const { api: anon } = await freshCtx();
    const SECRET = "s3cr3t-join-token-" + Date.now().toString(36);
    try {
      await anon.post(`/join/${SECRET}`, { data: {} });
      const st = await state(anon);
      expect(st.tracked).toBe(true);
      expect(JSON.stringify(st.sample_paths)).toContain("[REDACTED]");
      expect(JSON.stringify(st.sample_paths)).not.toContain(SECRET);
    } finally { await anon.dispose(); }
  });

  test("a live block SURVIVES the counting window rolling over", async () => {
    // A latent bug this release also closes. The COUNT half has no admin
    // exemption (only the BLOCK half does), so a signed-in admin sharing a
    // blocked address keeps landing counted 4xx — and the first one after the
    // 10-minute roll replaced the whole record with `blockedUntil: null`,
    // silently lifting a 15-minute block a third of the way through, for
    // everyone on that address, with nothing recording that it had happened.
    const { api: anon } = await freshCtx();
    const { api: admin } = await apiLogin("superadmin");
    try {
      for (let i = 1; i <= 40; i++) await anon.get(PROBE_PATHS[i % PROBE_PATHS.length] + "?w=" + i);
      expect((await state(anon)).blocked, "precondition: the address is blocked").toBe(true);

      // Cross the window boundary, then land one counted 4xx from the ADMIN —
      // who is exempt from the block but is still counted, which is exactly the
      // path that used to lift it.
      await anon.post("/api/test/scanner-age-window", { data: { ip: "127.0.0.1" } });
      // A CSRF-less POST: a guaranteed non-429 4xx from an authenticated admin.
      const probe = await admin.post("/api/admin/competitions", { data: { name: "x" } });
      expect(probe.status(), "the admin's own request is a countable 4xx and is NOT refused").toBeGreaterThanOrEqual(400);
      expect(probe.status()).not.toBe(429);

      const after = await state(anon);
      expect(after.blocked, "the block outlives the window that produced it").toBe(true);
      // …and the counters DID reset: carrying them forward would leave probe4xx
      // already past the early threshold against a count4xx restarting at zero,
      // so the ratio would exceed 1 and the early block would re-fire on a
      // single request of fresh evidence.
      expect(after.count_4xx).toBeLessThan(40);
      expect(after.probe_4xx).toBe(0);
    } finally { await admin.dispose(); await anon.dispose(); }
  });
});

// ── the classification matrix, as pure unit tests ────────────────────────────
//
// lib/scanner-classify.js requires NOTHING, so a spec may require it at module
// scope (the v7.20.2 lock is about reaching db.js). These carry the shapes that
// would each cost a separate HTTP cascade to reach.
test.describe("Scanner classifier (v7.25.0)", () => {
  // v8.3.20 — mirrors _scannerRecord's shape, including the 64-bucket
  // (two-word) distinct fingerprint the scale silence arm needs.
  const build = (hits) => {
    const r = {
      count4xx: 0, probe4xx: 0, routed4xx: 0, other4xx: 0,
      probeBits: 0, probeBitsHi: 0, signatureBits: 0, signatureBitsHi: 0,
      signatureHits: 0, probeSample: [],
    };
    for (const h of hits) {
      r.count4xx++;
      const b = classify.classifyHit(h);
      if (b === "routed") r.routed4xx++;
      else if (b === "probe") {
        r.probe4xx++;
        [r.probeBits, r.probeBitsHi] = classify.addPathBit(r.probeBits, r.probeBitsHi, h.path);
        if (classify.isProbeSignature(h.path)) {
          r.signatureHits++;
          [r.signatureBits, r.signatureBitsHi] = classify.addPathBit(r.signatureBits, r.signatureBitsHi, h.path);
        }
      } else r.other4xx++;
    }
    return r;
  };
  const rep = (n, mk) => Array.from({ length: n }, (_, i) => mk(i));
  const scannerHits = (n = 40) => rep(n, i => ({ path: PROBE_PATHS[i % PROBE_PATHS.length], routed: false, status: 404 }));

  test("a dictionary walk is a probe, and is due an early block", () => {
    const rec = build(scannerHits(40));
    const v = classify.classifyScannerTraffic(rec);
    expect(v.verdict).toBe("probe");
    expect(v.silent).toBe(true);
    expect(classify.probeEarlyBlockDue(rec)).toBe(true);
  });

  test("a roomful of expired sessions is a COHORT — the case the alert exists for", () => {
    const v = classify.classifyScannerTraffic(build(rep(120, () => ({ path: "/api/status", routed: true, status: 401 }))));
    expect(v.verdict).toBe("cohort");
    expect(v.silent).toBe(false);
  });

  test("ordinary browser 404s never silence an address", () => {
    // This platform ships no /robots.txt, no /favicon.ico and no
    // /.well-known/**, so a roomful of freshly-opened browsers produces
    // unrouted 404s on DISTINCT paths as a matter of course. Without the benign
    // exclusion — and without requiring evidence of malice — that shape could
    // be classified as a scanner and a venue would be silenced, which is the
    // one outcome this feature must never produce.
    const wellKnown = ["/favicon.ico", "/apple-touch-icon.png", "/robots.txt",
      "/.well-known/appspecific/com.chrome.devtools.json", "/sitemap.xml",
      "/apple-touch-icon-precomposed.png", "/browserconfig.xml"];
    const v = classify.classifyScannerTraffic(build(rep(140, i => ({ path: wellKnown[i % wellKnown.length], routed: false, status: 404 }))));
    expect(v.verdict).toBe("cohort");
    expect(v.silent).toBe(false);
    expect(v.probe_4xx, "a well-known browser path is not probe evidence at all").toBe(0);
  });

  test("padding real attacks with junk 404s cannot buy silence", () => {
    // The adversarial case. Without the routed-4xx guard an attacker could
    // bury credential stuffing under a pile of junk 404s to lift the probe
    // ratio and DELIBERATELY suppress the alert on the activity an operator
    // needs to hear about.
    const v = classify.classifyScannerTraffic(build([
      ...scannerHits(40),
      ...rep(6, () => ({ path: "/api/login", routed: true, status: 401 })),
    ]));
    expect(v.verdict).toBe("mixed");
    expect(v.silent, "six routed 4xx are enough to force a notification").toBe(false);
  });

  test("a stale deploy 404ing its own modules is not malice", () => {
    // Many distinct unrouted 404s, zero known-bad signatures. It alerts, and it
    // is not blocked early — a signature list that went stale would degrade to
    // exactly this, which is the safe direction.
    const rec = build(rep(40, i => ({ path: `/js/features/gone-${i}.js`, routed: false, status: 404 })));
    const v = classify.classifyScannerTraffic(rec);
    expect(v.silent).toBe(false);
    expect(classify.probeEarlyBlockDue(rec)).toBe(false);
  });

  test("an unrouted NON-404 is neither probe evidence nor proof of a real client", () => {
    // The /docs gate answers 401 from inside an app.use mount, and the body
    // parsers 413 from another, so neither carries req.route. Counting those as
    // "a real endpoint answered" would force an alert for a scanner walking
    // /docs; counting them as probes would help silence one.
    const v = classify.classifyScannerTraffic(build(rep(40, () => ({ path: "/docs/user-guide/superadmin.md", routed: false, status: 401 }))));
    expect(v.probe_4xx).toBe(0);
    expect(v.routed_4xx).toBe(0);
    expect(v.other_4xx).toBe(40);
    expect(v.silent).toBe(false);
  });

  test("no evidence at all is never silence", () => {
    expect(classify.classifyScannerTraffic({}).silent).toBe(false);
    expect(classify.classifyScannerTraffic({ count4xx: 0 }).verdict).toBe("cohort");
  });

  test("the distinct-path fingerprint saturates and never over-counts", () => {
    // It under-counts by design (collisions), which makes the distinct bar
    // HARDER to clear — so it makes silence harder to reach and the early block
    // later to fire. Both are the safe direction.
    //
    // v8.3.20 — SATURATION MOVED FROM 32 TO 64, and that is the whole reason the
    // scale silence arm can exist. On the old single word a ratio-1.0 walk at
    // the 100-4xx block read a mean of 30.7 against a ceiling of 32, so no bar
    // above ~26 was reachable at the moment the decision is taken. The subject
    // of this test — saturates, never over-counts, idempotent — is unchanged.
    let lo = 0, hi = 0;
    for (let i = 0; i < 1000; i++) [lo, hi] = classify.addPathBit(lo, hi, `/p/${i}`);
    expect(classify.probeDistinct(lo, hi)).toBe(64);
    let flo = 0, fhi = 0;
    for (const p of PROBE_PATHS.slice(0, 12)) [flo, fhi] = classify.addPathBit(flo, fhi, p);
    expect(classify.probeDistinct(flo, fhi)).toBeLessThanOrEqual(12);
    expect(classify.probeDistinct(flo, fhi)).toBeGreaterThanOrEqual(8);
    // Idempotent: the same path twice is one distinct path.
    expect(classify.addPathBit(...classify.addPathBit(0, 0, "/x"), "/x"))
      .toEqual(classify.addPathBit(0, 0, "/x"));
    // A record written by an older process image carries no `hi` word. It must
    // read as the LOW word alone — i.e. under-count — never NaN.
    expect(classify.probeDistinct(classify.addPathBit(0, 0, "/x")[0])).toBe(1);
  });

  // ── v8.3.20: the SCALE silence arm ────────────────────────────────────────
  //
  // Reported from production: an address that was unmistakably a scanner — a
  // long run of requests for things that do not exist here — still emailed every
  // superadmin. It failed exactly one of the four silence conditions,
  // PROBE_SIGNATURE_MIN, because its dictionary matched no known-bad pattern.
  // Silence now has a second arm whose evidence is SCALE rather than a
  // signature. Every test below drives a path set with ZERO signature matches,
  // which is what makes the arm the only thing that can be deciding.
  const NOSIG = (n) => rep(n, i => ({ path: `/manager/html/node-${i}`, routed: false, status: 404 }));

  test("v8.3.20: a wide no-signature walk at volume is SILENCED — the operator's case", () => {
    const rec = build(NOSIG(100));
    const v = classify.classifyScannerTraffic(rec);
    // The precondition that makes this test about the SCALE arm and nothing
    // else: not one of these paths matches a known-bad signature, so the
    // v7.25.0 arm cannot be what fired.
    expect(v.signature_distinct_paths, "fixture must carry NO signature evidence").toBe(0);
    expect(v.silent).toBe(true);
    expect(v.silence_basis).toBe("scale");
    expect(v.verdict).toBe("probe");
  });

  test("v8.3.20: the SIGNATURE arm still decides on its own, at a scale the new arm refuses", () => {
    // The control that stops "silence works" being satisfied by a build that
    // silences everything at volume: 40 hits is BELOW PROBE_VOLUME_SCALE_MIN, so
    // only the signature arm can carry it.
    const v = classify.classifyScannerTraffic(build(scannerHits(40)));
    expect(v.silent).toBe(true);
    expect(v.silence_basis).toBe("signature");
    expect(v.probe_4xx).toBeLessThan(classify.PROBE_VOLUME_SCALE_MIN);
  });

  test("v8.3.20: SIX routed 4xx still force a notification, however wide the walk", () => {
    // THE ADVERSARIAL GUARD, and the one condition that is a security property
    // rather than a tuning choice. It is the SAME constant on both arms, so an
    // attacker cannot pad credential stuffing with junk 404s to buy silence —
    // and a venue sharing its NAT with a scanner is still announced.
    const v = classify.classifyScannerTraffic(build([
      ...NOSIG(120),
      ...rep(6, () => ({ path: "/api/login", routed: true, status: 401 })),
    ]));
    expect(v.routed_4xx).toBe(6);
    expect(v.silent, "six routed 4xx outrank any amount of scale").toBe(false);
    expect(v.silence_basis).toBe(null);
  });

  test("v8.3.20: a venue's own benign 404s dilute the ratio and force a notification", () => {
    // The realistic mixed case: a scanner INSIDE the venue's NAT while the room
    // is opening the site. The browser well-knowns score `other`, never `probe`,
    // so they push the ratio below PROBE_RATIO_SCALE_MIN — which is exactly what
    // that stricter ratio is for, since successful venue traffic is invisible
    // here (only 4xx are counted).
    const v = classify.classifyScannerTraffic(build([
      ...NOSIG(100),
      ...rep(40, () => ({ path: "/favicon.ico", routed: false, status: 404 })),
    ]));
    expect(v.routed_4xx).toBe(0);
    expect(v.probe_ratio).toBeLessThan(classify.PROBE_RATIO_SCALE_MIN);
    expect(v.silent, "a room's own 404s must still buy an alert").toBe(false);
  });

  test("v8.3.20: volume alone is not evidence — a single dead path hammered 300 times ALERTS", () => {
    // req.path is query-stripped, so a fuzzer pounding /x?payload=<i> is ONE
    // distinct path. Indistinguishable from a broken client on the venue's
    // network repeatedly asking for something that no longer exists, so it must
    // alert. This is why the arm requires DISTINCT paths and not merely volume.
    const v = classify.classifyScannerTraffic(build(rep(300, () => ({ path: "/x", routed: false, status: 404 }))));
    expect(v.probe_4xx).toBe(300);
    expect(v.probe_distinct_paths).toBe(1);
    expect(v.silent).toBe(false);
  });

  test("v8.3.20: the distinct bar holds for STRUCTURED path families, not only random ones", () => {
    // THE MEASUREMENT THE SCALE ARM RESTS ON, pinned against the input class it
    // is claimed for. FNV-1a's avalanche in the LOW bits is poor for paths that
    // share a prefix, a length and a numeric suffix — which is the shape of an
    // asset family and exactly what a venue's 404s look like. Before the
    // finalizer, `/assets/chunk-000.js` … `chunk-040.js` (41 paths) read 40 of
    // 64, CLEARING the bar, and 96 same-shaped paths saturated the mask
    // entirely — so the calibration was true for the random strings it was
    // sampled from and false for the case that matters, and "collisions only
    // ever UNDER-count" did not hold either.
    //
    // The property is a CROSSOVER, asserted in both directions per family: a
    // venue-sized set must stay below the bar and a walk-sized set must clear
    // it. Without the low arm this passes on a build that reads everything as
    // saturated; without the high arm it passes on one that reads everything as
    // zero.
    const families = {
      "bundled assets":      i => `/assets/chunk-${String(i).padStart(3, "0")}.js`,
      "raw SPA modules":     i => `/js/features/gone-${i}.js`,
      "doc screenshots":     i => `/docs/screenshots/admin/${String(i).padStart(2, "0")}-shot.png`,
      "an appliance walk":   i => `/manager/html/node-${i}`,
      "random junk":         i => `/x/${i}-${(i * 2654435761 >>> 0).toString(36)}`,
    };
    const readOf = (gen, n) => {
      let lo = 0, hi = 0;
      for (let i = 0; i < n; i++) [lo, hi] = classify.addPathBit(lo, hi, gen(i));
      return classify.probeDistinct(lo, hi);
    };
    for (const [label, gen] of Object.entries(families)) {
      // The worst venue shape: every file of the raw-module SPA, and more.
      expect(readOf(gen, 41), `${label}: 41 distinct paths must stay BELOW the scale bar`)
        .toBeLessThan(classify.PROBE_DISTINCT_SCALE_MIN);
      // What a dictionary walk holds by the time the standard block fires.
      expect(readOf(gen, 100), `${label}: 100 distinct paths must CLEAR the scale bar`)
        .toBeGreaterThanOrEqual(classify.PROBE_DISTINCT_SCALE_MIN);
    }
  });

  test("v8.3.20: the whole raw-module SPA 404ing is BELOW the distinct bar", () => {
    // The worst venue shape there is, and the anti-vacuity floor under
    // PROBE_DISTINCT_SCALE_MIN. public/js/** holds 41 files in total, and only
    // in the raw-module serving mode production does not use (the shipped image
    // sets NODE_ENV=production and serves ONE bundle). Measured over 800 trials
    // of the real fnv1a32, 41 distinct paths read at most 37 of 64 — so this
    // must never be silenced however many clients request them.
    const rec = build(rep(200, i => ({ path: `/js/features/gone-${i % 41}.js`, routed: false, status: 404 })));
    const v = classify.classifyScannerTraffic(rec);
    expect(v.probe_4xx, "volume is well past the bar — only DISTINCT saves it").toBeGreaterThan(classify.PROBE_VOLUME_SCALE_MIN);
    expect(v.probe_distinct_paths).toBeLessThan(classify.PROBE_DISTINCT_SCALE_MIN);
    expect(v.silent).toBe(false);
  });

  test("v8.3.20: the scale arm never blocks EARLIER than it would have — only quieter", () => {
    // probeEarlyBlockDue delegates to the one silence predicate, so the scale
    // arm's own volume floor (80) dominates the early threshold (25). A
    // no-signature walk therefore early-blocks at 80 rather than 25, while a
    // signature walk still early-blocks at 25: less evidence, more volume.
    expect(classify.probeEarlyBlockDue(build(NOSIG(40))), "40 no-signature hits must not block early").toBe(false);
    expect(classify.probeEarlyBlockDue(build(NOSIG(100)))).toBe(true);
    expect(classify.probeEarlyBlockDue(build(scannerHits(40))), "a signature walk is unchanged").toBe(true);
  });

  test("v8.3.20: a pure-probe walk that is NOT silenced is not told it reached real pages", () => {
    // `verdict` is derived from the RATIO alone, so a walk with no signature
    // match and too few distinct paths lands in "mixed" while having touched no
    // real endpoint at all — and the mixed copy asserted that "some of it
    // reached real pages of the platform". The classifier's own counter said
    // otherwise, which is what the alert copy branches on now.
    const v = classify.classifyScannerTraffic(build(NOSIG(40)));
    expect(v.verdict).toBe("mixed");
    expect(v.routed_4xx, "the counter the copy must branch on").toBe(0);
    const copy = alerts.alertCopy(
      { ip: "203.0.113.9", blocked_until: new Date(Date.now() + 9e5).toISOString(), count_4xx: 140,
        competition_name: "Venue Cup", accepts_trusted_ips: true, verdict: v.verdict, routed_4xx: v.routed_4xx },
      null);
    expect(copy).not.toContain("some of it reached real pages of the platform");
    expect(copy).toContain("All of that traffic was asking for things this platform does not have");
  });

  test("a stored sample path is a standalone copy, not a view onto the request line", () => {
    // V8's String.prototype.slice returns a SlicedString that RETAINS its
    // parent, and req.path is itself a view onto a request line Node accepts up
    // to ~16 KB. Five "80-character" samples per address at the tracker's
    // 10 000-address cap would then be hundreds of megabytes, from an
    // unauthenticated caller.
    const huge = "/x".repeat(8000);
    const flat = classify.flattenPath(huge, 80);
    expect(flat.length).toBe(80);
    // A flattened copy is not a slice of the original — asserted by the one
    // property that distinguishes them without reaching into V8 internals: it
    // survives the parent going out of scope with its own backing store, and
    // its length is exactly the bound rather than the parent's.
    expect(flat).toBe(huge.slice(0, 80));
  });
});

// A browser whose session ended still presents its cookie, and its next requests
// are refused: counted, a classroom whose sessions end together over a long break
// or a restart blocked its own address (operator ruling, 17 Nov 2026, server.js
// `_isStaleSessionRefusal`). Controls: the same refusal with no cookie, and with a
// live anonymous session's cookie, still counts.
test.describe("A session that ended is not counted as abuse when its browser finds out", () => {
  test.beforeEach(async () => {
    const { api: anon } = await freshCtx();
    try { await disarm(anon); await armTracker(anon); } finally { await anon.dispose(); }
  });
  test.afterEach(async () => {
    const { api: anon } = await freshCtx();
    try { await disarm(anon); } finally { await anon.dispose(); }
  });

  test("a dead session's refused poll and keepalive are not counted; the same refusals without it are", async () => {
    const { TEST_DB_PATH } = require("./helpers");
    const { makeParticipant } = require("./event-admin-helpers");
    const { api: sa, csrf } = await apiLogin("superadmin");
    let p;
    try { p = await makeParticipant(sa, csrf, "stalecookie"); } finally { await sa.dispose(); }
    const P = await apiLogin(p.email);
    const { api: anon } = await freshCtx();
    const count = async () => (await state(anon)).count_4xx || 0;
    try {
      expect((await P.api.get("/api/my-competitions")).status(), "PRECONDITION: the session is live").toBe(200);
      const Database = require("better-sqlite3");
      const db = new Database(TEST_DB_PATH, { timeout: 5000 });
      try {
        const ended = db.prepare("DELETE FROM express_session WHERE (CASE WHEN json_valid(data) THEN json_extract(data, '$.userId') END)=?").run(p.id).changes;
        expect(ended, "PRECONDITION: the session existed").toBeGreaterThan(0);
      } finally { db.close(); }

      const c0 = await count();
      for (let i = 0; i < 3; i++) expect((await P.api.get("/api/my-competitions")).status(), "the dead session's poll is refused").toBe(401);
      const ka = await P.api.post("/api/session/keepalive", { headers: { "X-CSRF-Token": P.csrf } });
      expect(ka.status(), "and its keepalive refused as csrf_invalid").toBe(403);
      expect(await count(), "none of it counted").toBe(c0);

      // CONTROL: the same refused poll from a caller that never had a session.
      const { api: nobody } = await freshCtx();
      try {
        for (let i = 0; i < 3; i++) expect((await nobody.get("/api/my-competitions")).status()).toBe(401);
      } finally { await nobody.dispose(); }
      expect(await count(), "a caller with no session is counted").toBe(c0 + 3);

      // CONTROL: and from one presenting a LIVE anonymous session's cookie.
      const { api: anonLive } = await freshCtx();
      try {
        expect((await anonLive.get("/api/csrf-token")).ok(), "PRECONDITION: an anonymous session was made").toBe(true);
        expect((await anonLive.get("/api/my-competitions")).status()).toBe(401);
      } finally { await anonLive.dispose(); }
      expect(await count(), "a live anonymous session is counted").toBe(c0 + 4);
    } finally { await P.api.dispose(); await anon.dispose(); }
  });
});
