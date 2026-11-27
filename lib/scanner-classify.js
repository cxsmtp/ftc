"use strict";
//
// v7.25.0 — telling a SCANNER apart from a VENUE, so only one of them is
// announced.
//
// The scanner-reputation tracker in server.js blocks an address after enough
// rejected requests, and v7.16.0 added an operator alert on top of it because
// the block is IP-wide: at a hackathon the whole room shares one NAT egress
// address, so a block can lock everyone out and the only symptom is "it's
// broken". That alert is right for a venue and pure noise for a scanner —
// reported from production, where the actor was unmistakable (it walked
// /.env, /wp-admin, /phpmyadmin) and every superadmin got an email about a
// block that needed no decision from anybody.
//
// This module is the decision, and nothing else. It is PURE and requires
// NOTHING — not db, not log, not fs — so a spec can require it at module
// scope (the v7.20.2 lock) and the whole threshold matrix is a unit test
// rather than a spawned server.
//
// THE FAILURE DIRECTIONS ARE NOT SYMMETRIC, and every threshold here is
// chosen from that. Alerting about a scanner costs an email nobody needed.
// Staying silent about a venue costs a room full of people locked out with
// nothing on any screen saying why — which is the entire reason the alert
// subsystem exists. So SILENCE REQUIRES POSITIVE EVIDENCE OF MALICE and
// anything ambiguous alerts, exactly as v7.20.9 (F6) argued in this same
// subsystem: "a duplicate notification is far cheaper than a lost one".

// ── the four thresholds ─────────────────────────────────────────────────────
//
// A block is silenced only when ALL of these hold. They are independent
// conditions, not a score, so no single signal can carry the decision.

// Of the countable 4xx in the window, how much must be probe traffic.
// A venue polling with expired sessions produces ROUTED 401s and scores 0.00
// here; a dictionary scanner scores ~1.00. 0.80 leaves headroom for the
// incidental routed 4xx a scanner also generates (a POST /api/login attempt,
// a /verify with no code) without the ratio becoming the load-bearing guard.
const PROBE_RATIO_MIN = 0.8;

// How many DISTINCT probe paths. Counted through a saturating fingerprint that
// under-counts (see probeDistinct). At the 32 buckets this shipped with, a
// reading of 8 meant ~9 true paths; the v8.3.20 widening to 64 buckets moved
// that to ~8.5, i.e. CLOSER to the number this constant actually names — the
// old bias was an erratum, not a specification, and the direction of the change
// is toward the stated intent. Nothing else moves with it: the signature arm
// still requires three distinct KNOWN-BAD paths, which no first-party request
// on this platform can produce, and `ROUTED_4XX_MAX` is untouched. A browser
// asks for the same few missing files over and over; a dictionary walk passes
// this within a second.
const PROBE_DISTINCT_MIN = 8;

// THE ADVERSARIAL GUARD, and the load-bearing number of the four.
//
// A routed 4xx means a REAL ENDPOINT of this platform answered — which is
// only possible if real clients are in the traffic. Any meaningful volume of
// that and the operator must be told before the address is blocked.
//
// It also closes the obvious attack: without it, an attacker could pad
// credential stuffing with a pile of junk 404s to lift the probe ratio and
// distinct-path count and DELIBERATELY SUPPRESS the alert on the activity an
// operator needs to hear about. Six routed 4xx make that impossible.
const ROUTED_4XX_MAX = 5;

// Distinct paths matching a known-bad signature. This is the positive
// evidence, and it is required for silence — not merely for the early block.
//
// Without it the predicate would be "many distinct unrouted 404s and few
// routed 4xx", which a roomful of freshly-opened browsers can satisfy: this
// platform ships no /robots.txt, no /favicon.ico and no /sitemap.xml, so
// well-known browser probes 404 here. Those are excluded as BENIGN below,
// but relying on that exclusion staying complete would put a venue one
// unlisted well-known path away from being silenced. Requiring malice makes
// a stale signature list fail SAFE: it silences less and alerts more, i.e.
// it degrades to the behaviour that shipped before this module existed.
//
// DISTINCT paths, not hits: one URL fetched three times by a retrying client
// is one piece of evidence, not three.
const PROBE_SIGNATURE_MIN = 3;

// ── the SCALE arm (v8.3.20) ─────────────────────────────────────────────────
//
// Reported from production, again: an address that was unmistakably a scanner —
// a long run of requests for things that do not exist here — still emailed every
// superadmin and raised the modal on every admin screen.
//
// The four conditions above are a conjunction, and the one it failed is
// PROBE_SIGNATURE_MIN. That gate demands three distinct paths matching a
// hand-written known-bad list, and whole modern scanner families match NONE of
// it: Tomcat /manager/html, /geoserver/web/, Fortinet /remote/fgt_lang,
// /Telerik.Web.UI_*, CouchDB /_all_dbs, registry /v2/_catalog, Liferay
// /api/jsonws/invoke, and every random-junk-path fuzzer. Such an address
// collects its hundred 404s, is blocked, and alerts.
//
// EXTENDING THE LIST IS NOT THE FIX. It is a blocklist over an adversary-chosen,
// unbounded space; every new family would need a code change and a deploy; the
// header above already concedes it will go stale; and "we now cover all
// scanners" is unfalsifiable, so no test can hold it. It is not free either — a
// signature match lowers the early-block bar from PROBE_VOLUME_SCALE_MIN to
// PROBE_EARLY_THRESHOLD for those paths, which is a security-relevant behaviour
// change to bundle into a noise fix.
//
// So silence gains a SECOND arm, and the evidence it requires is SCALE rather
// than a signature: an address that asked for dozens of DIFFERENT things this
// platform has never had, at volume, while barely touching a real endpoint, is
// not a room of browsers. THE DOCTRINE ABOVE IS NOT WEAKENED — it says silence
// requires positive evidence of malice, and its concrete worry is that "many
// distinct unrouted 404s and few routed 4xx" is satisfiable by a roomful of
// freshly-opened browsers. That is exactly right AT EIGHT DISTINCT PATHS. It is
// not right an order of magnitude up, and the venue ceiling is checkable:
//   • the browser well-knowns are excluded as BENIGN_UNROUTED, so they score
//     ZERO probe hits — the existing test drives 140 of them and asserts it;
//   • the shipped image sets NODE_ENV=production, so the SPA loads ONE bundled
//     /js/core/main.js, and asset URLs are ?v=<hash> over stable filenames, so a
//     deploy changes no path;
//   • even the raw-module serving mode production does not use has 41 files in
//     public/js/** in total.
// A venue's ceiling on distinct non-benign unrouted 404 paths is therefore tens,
// in a serving mode production does not run — while a dictionary walk reaching
// the block has ~100 of them.
//
// AND THE ROUTED GUARD IS UNCHANGED AND SHARED. `ROUTED_4XX_MAX` applies to this
// arm through the SAME constant, not a copy: a venue that is producing 404s at
// volume is simultaneously producing routed 4xx far past five (expired-session
// 401s on /api/status, /api/leaderboard, /api/admin/*), and it is what stops an
// attacker padding credential stuffing with junk to buy silence.

// Distinct probe paths, read off the 64-bucket fingerprint below. MEASURED
// against the shipped hash — over random strings AND over four STRUCTURED
// families (same prefix, same length, numeric suffix), which is the shape a
// venue's 404s actually take and the case a random-string sample misses
// entirely: 41 true distinct paths (the whole raw-module SPA, the worst venue
// shape there is) reads 28-32, while the ~100 a ratio-1.0 walk holds when the
// block fires reads 48-54. So this bar is unreachable by the worst venue and
// cleared every time by a real walk. Around 60-80 true paths it becomes
// probabilistic and therefore fails toward ALERT, which is the correct
// direction.
const PROBE_DISTINCT_SCALE_MIN = 40;

// Probe hits in the window. Bounded ABOVE by the block itself: classification
// happens at block creation, so any bar at or above the 100-4xx standard
// threshold could never fire. 80 leaves headroom for a ratio below 1.0 (at 0.90
// the standard block yields 90 probe hits) and early-blocks a wide walk about
// twenty requests sooner rather than seventy-five.
const PROBE_VOLUME_SCALE_MIN = 80;

// A STRICTER ratio than the signature arm's 0.80, and its job is specific: to
// detect a MIXED address — a real venue sharing a NAT with a scanner, where the
// room genuinely is locked out and the operator genuinely must be told.
// Successful venue traffic contributes nothing (only 4xx are counted), so the
// venue is visible only through its own 4xx: routed 401/403, caught by
// ROUTED_4XX_MAX, and benign well-known 404s, which land in `other4xx` and are
// caught HERE. With no malice signal on this arm, "dominated by probe traffic"
// has to mean overwhelmingly; 0.90 still leaves a scanner one hit in ten of
// slack for its own incidental /robots.txt and /favicon.ico.
const PROBE_RATIO_SCALE_MIN = 0.9;

// The probe-specific early block. The operator's report noted "a substantial
// amount of 404 errors before the protection kicked in" — 100 rejected
// requests is a long run of secret-fishing. An address that has produced 25
// probe hits AND satisfies every silence condition above has already proven
// what it is.
//
// Deliberately UNCHANGED by the scale arm, and it needs no change: that arm's
// own PROBE_VOLUME_SCALE_MIN (80) dominates this threshold, so a no-signature
// walk early-blocks at 80 while a signature walk still early-blocks at 25. Less
// evidence, more volume — and `probeEarlyBlockDue` keeps delegating to the one
// silence predicate, so "the early block only ever fires for traffic that would
// ALSO be silenced" stays true by construction rather than by a second copy.
const PROBE_EARLY_THRESHOLD = 25;

// Sample paths carried into the log line and the audit event so an operator
// reading a silent block can answer "was it really a scanner?" — which needs
// paths, not a cardinality.
const PROBE_SAMPLE_MAX = 5;
const PROBE_SAMPLE_PATH_MAX = 80;

// ── path signatures ─────────────────────────────────────────────────────────

// Known-bad. Used as EVIDENCE OF MALICE (a gate on silence and on the early
// block) — never as the definition of a probe, which stays the router's own
// answer. A path this list misses simply produces an alert.
const PROBE_SIGNATURES = [
  // The strongest of them: this platform has no server-side scripting at all,
  // so nothing here can ever legitimately ask for one of these.
  /\.(php\d?|asp|aspx|jsp|cgi|cfm|pl)(\/|$)/,
  /(^|\/)\.(env|git|svn|aws|ssh|htpasswd|htaccess|ds_store|npmrc|dockerenv)(\/|$)/,
  /(^|\/)(wp-admin|wp-content|wp-includes|wp-login|wordpress|xmlrpc)(\/|$)/,
  /(^|\/)(phpmyadmin|pma|myadmin|adminer|sqlmanager|dbadmin)(\/|$)/,
  /(^|\/)(cgi-bin|autodiscover|owa|boaform|hnap1|solr|struts|jenkins|actuator|druid|telescope|_ignition|_profiler)(\/|$)/,
  /(^|\/)(config|configuration|backup|backups|dump|database|db|credentials|secret|secrets|passwords?)\.(json|ya?ml|xml|txt|sql|zip|tar|gz|bak|old|ini|conf)$/,
  /(^|\/)(id_rsa|id_dsa|\.?netrc|web\.config|server-status|server-info)(\/|$)/,
];

// Unrouted 404s a perfectly ordinary browser or crawler produces. This
// platform serves favicon.webp and declares it on every HTML entry point, and
// ships none of the other well-known files — so these 404 here through no
// fault of the client. They are excluded from the probe count entirely, which
// makes silence HARDER to reach, never easier.
const BENIGN_UNROUTED = [
  /^\/favicon\.(ico|png)$/,
  /^\/apple-touch-icon(-precomposed)?(-\d+x\d+)?\.png$/,
  /^\/(robots\.txt|sitemap[^/]*\.xml|browserconfig\.xml|humans\.txt|ads\.txt|security\.txt)$/,
  /^\/\.well-known\//,
  /^\/manifest\.(json|webmanifest)$/,
];

// ── hit classification ──────────────────────────────────────────────────────

/**
 * Which bucket a single countable 4xx belongs to.
 *
 *   "routed" — a method-specific route matched, i.e. a real endpoint of this
 *              platform answered. `routed` comes from Express's own `req.route`,
 *              which is a POSITIVE, router-derived answer rather than a path
 *              list that goes stale as the app grows. Adding a route can only
 *              ever move a path INTO this bucket.
 *   "probe"  — an unrouted 404 that is not one of the benign well-known paths:
 *              the platform has nothing at all there and the client asked
 *              anyway.
 *   "other"  — everything else countable. Two real cases live here and both
 *              matter: an unrouted NON-404 (the /docs gate answers 401 from
 *              inside an app.use mount, and the body parsers 413 from one
 *              too), and a benign well-known 404. Neither is evidence of
 *              malice, and neither proves a real client either — so it is
 *              reported and gates nothing.
 */
function classifyHit(hit) {
  if (!hit) return "other";
  if (hit.routed) return "routed";
  if (hit.status !== 404) return "other";
  const p = String(hit.path || "").toLowerCase();
  for (const re of BENIGN_UNROUTED) if (re.test(p)) return "other";
  return "probe";
}

function isProbeSignature(path) {
  const p = String(path || "").toLowerCase();
  for (const re of PROBE_SIGNATURES) if (re.test(p)) return true;
  return false;
}

// ── the distinct-path fingerprint ───────────────────────────────────────────
//
// A 32-bit saturating bitmask, NOT a Set. The classifier only ever asks
// "at least N distinct?", never for an exact count, and a per-IP Set is a
// memory amplifier fed by exactly the traffic being classified: at the
// tracker's existing 10 000-address cap it is tens of megabytes, in a
// single-process server, reachable by an unauthenticated caller. This is four
// bytes per address, flat.
//
// Collisions make it UNDER-count (k distinct paths read as 32·(1−(31/32)^k):
// 8→7.2, 12→10.2, 20→15.1). That is the safe direction twice over — it makes
// the distinct bar harder to clear, so it makes silence harder to reach and
// the early block later to fire.

function fnv1a32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

// v8.3.20 — TWO WORDS, 64 BUCKETS. The single 32-bit word could not express the
// scale arm's bar: MEASURED over 800 trials, a ratio-1.0 walk hitting the 100-4xx
// block has ~100 distinct paths and reads a mean of 30.7 with a MAXIMUM of 32, so
// any 32-bit bar above ~26 is either unreachable at the moment the decision is
// taken or a coin flip. At 64 buckets the same walk reads 43-58, and the worst
// venue shape (41 distinct) reads at most 37 — a real gap to put a threshold in.
//
// Still a saturating mask, not a Set: the header's memory argument is unchanged
// (a per-IP Set is an amplifier fed by the very traffic being classified, at a
// 10 000-address cap, from an unauthenticated caller). This costs four more bytes
// per fingerprint — ~160 KB at the cap for both masks, against a record that
// already holds five 80-character sample strings.
//
// The low bits pick the BIT and bit 5 picks the WORD, from one hash. Collisions
// still make the reading UNDER-count, which stays the safe direction twice over:
// harder to clear the distinct bar, so harder to reach silence and later to
// early-block.
// v8.3.20 — THE HASH IS FINALIZED BEFORE ITS BITS ARE USED, and this is a
// correctness fix rather than polish.
//
// FNV-1a's avalanche in the LOW bits is poor for inputs that share a prefix, a
// length and a numeric suffix — which is exactly the shape of an asset family,
// and exactly what a venue's 404s look like. MEASURED on the real function:
// `/assets/chunk-000.js` … `chunk-040.js` (41 paths) read **40** of 64 —
// clearing the scale arm's bar — where the random model predicts ~30; and 96
// same-shaped paths SATURATED the mask at 64. So the calibration this arm rests
// on ("41 distinct reads at most 37") was true for random-like strings and false
// for the structured input that matters, and the "collisions only ever
// UNDER-count" property did not hold either.
//
// A single lowbias32 finalizer restores it. Re-measured across four structured
// families plus random strings: k=41 now reads 28-32 in EVERY family (safely
// below the bar) and k=100 reads 48-51 (safely above), i.e. the documented
// crossover exists in the input class it is claimed for rather than only in the
// one it was sampled from.
function _mix32(x) {
  x = x >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d) >>> 0;
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b) >>> 0;
  x ^= x >>> 16;
  return x >>> 0;
}

function addPathBit(lo, hi, path) {
  const h = _mix32(fnv1a32(String(path || "")));
  const bit = (1 << (h & 31)) >>> 0;
  return ((h >>> 5) & 1)
    ? [lo >>> 0, ((hi | bit) >>> 0)]
    : [((lo | bit) >>> 0), hi >>> 0];
}

function popcount(bits) {
  let v = bits >>> 0;
  v = v - ((v >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  v = (v + (v >>> 4)) & 0x0f0f0f0f;
  return ((v * 0x01010101) >>> 24);
}

/**
 * Distinct probe paths seen, saturating at 64.
 *
 * `hi` is optional so a record written by an older process image (or a caller
 * that only ever had the one word) still reads correctly — as the low word
 * alone, i.e. it UNDER-counts, which is the safe direction.
 */
function probeDistinct(lo, hi) { return popcount(lo) + popcount(hi || 0); }

/**
 * Flatten a path into a short, standalone string.
 *
 * NOT merely `slice`. V8 returns a SlicedString from `String.prototype.slice`
 * that RETAINS ITS PARENT, and `req.path` is itself a view onto `req.url` —
 * so a "80-character" sample would pin the whole original URL, and Node
 * accepts request lines up to ~16 KB. Storing five of those per address at
 * the tracker's 10 000-address cap is hundreds of megabytes, from an
 * unauthenticated caller. `Buffer.from(...).toString()` forces a real copy.
 */
function flattenPath(path, max = PROBE_SAMPLE_PATH_MAX) {
  const s = String(path || "");
  return Buffer.from(s.slice(0, max), "utf8").toString("utf8");
}

// ── the verdict ─────────────────────────────────────────────────────────────

/**
 * Classify one address's window.
 *
 * `rec` is the tracker's per-IP record: { count4xx, probe4xx, routed4xx,
 * other4xx, probeBits, signatureBits, signatureHits }.
 *
 * Returns the wire/audit shape. `verdict` is three-valued on purpose:
 * `cohort` and `mixed` behave identically (both alert), but an operator
 * reading the audit stream can see the classifier running near a boundary,
 * which is how these thresholds would ever get tuned. All three values are
 * carried by the log line, the audit event and a /metrics label, so none of
 * them is a counter without a reader.
 */
function classifyScannerTraffic(rec) {
  const count4xx = Math.max(0, rec && rec.count4xx || 0);
  const probe4xx = Math.max(0, rec && rec.probe4xx || 0);
  const routed4xx = Math.max(0, rec && rec.routed4xx || 0);
  const other4xx = Math.max(0, rec && rec.other4xx || 0);
  const distinct = probeDistinct(rec && rec.probeBits || 0, rec && rec.probeBitsHi || 0);
  const sigDistinct = probeDistinct(rec && rec.signatureBits || 0, rec && rec.signatureBitsHi || 0);
  const sigHits = Math.max(0, rec && rec.signatureHits || 0);
  const ratio = count4xx > 0 ? probe4xx / count4xx : 0;

  // TWO ARMS, and the shared conjunct is the one that is a security property.
  //
  // The SIGNATURE arm is v7.25.0's, byte for byte: modest scale plus three
  // distinct known-bad paths. The SCALE arm replaces the signature requirement
  // with an order-of-magnitude higher bar on distinct paths and a volume floor —
  // see the constants above for why a venue cannot reach it. `ROUTED_4XX_MAX` is
  // the SAME constant on both, not a copy: it is what stops an attacker padding
  // credential stuffing with junk 404s to buy silence, and it is the reason a
  // venue sharing its NAT with a scanner still alerts.
  const probeBySignature =
    ratio >= PROBE_RATIO_MIN &&
    distinct >= PROBE_DISTINCT_MIN &&
    routed4xx <= ROUTED_4XX_MAX &&
    sigDistinct >= PROBE_SIGNATURE_MIN;

  const probeByScale =
    ratio >= PROBE_RATIO_SCALE_MIN &&
    distinct >= PROBE_DISTINCT_SCALE_MIN &&
    probe4xx >= PROBE_VOLUME_SCALE_MIN &&
    routed4xx <= ROUTED_4XX_MAX;

  const probe = probeBySignature || probeByScale;

  // Below half, real-surface failures dominate: this is the venue shape the
  // whole alert subsystem exists for. Between the two is "mixed" — it alerts
  // exactly like a cohort, and says so rather than pretending to be certain.
  const verdict = probe ? "probe" : (ratio < 0.5 ? "cohort" : "mixed");

  return {
    verdict,
    silent: probe,
    // WHICH arm decided, so an operator reading a silent block can tell "it
    // fished for /.env" from "it asked for sixty different things we have never
    // had". It rides the log line, the `scanner_blocked` audit event and
    // /api/test/scanner-state for free. Deliberately NOT a fourth `verdict`
    // value: _scannerBlockStats and the hack_arena_scanner_blocks_total{verdict}
    // label set are keyed on the three, and this is a different question.
    silence_basis: probeBySignature ? "signature" : (probeByScale ? "scale" : null),
    probe_4xx: probe4xx,
    routed_4xx: routed4xx,
    other_4xx: other4xx,
    probe_distinct_paths: distinct,
    probe_distinct_saturated: distinct >= 64,   // v8.3.20 — 64 buckets, was 32
    signature_hits: sigHits,
    signature_distinct_paths: sigDistinct,
    probe_ratio: Math.round(ratio * 100) / 100,
  };
}

/**
 * Is this address a clear enough prober to block BEFORE the ordinary 100-4xx
 * threshold?
 *
 * Deliberately the same predicate as silence plus a volume term, so there is
 * one definition of "unmistakably a scanner" rather than two that can drift.
 * Anything that would still have alerted keeps the old threshold exactly.
 */
function probeEarlyBlockDue(rec, threshold = PROBE_EARLY_THRESHOLD) {
  if (!rec || (rec.probe4xx || 0) < threshold) return false;
  return classifyScannerTraffic(rec).silent;
}

module.exports = {
  ROUTED_4XX_MAX,
  PROBE_DISTINCT_SCALE_MIN, PROBE_VOLUME_SCALE_MIN, PROBE_RATIO_SCALE_MIN,
  PROBE_EARLY_THRESHOLD, PROBE_SAMPLE_MAX, PROBE_SAMPLE_PATH_MAX,
  PROBE_SIGNATURES,
  classifyHit, isProbeSignature, addPathBit, probeDistinct, flattenPath,
  classifyScannerTraffic, probeEarlyBlockDue,
};
