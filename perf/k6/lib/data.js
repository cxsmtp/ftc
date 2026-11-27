import { SharedArray } from "k6/data";

// Load seed data at init time (once, shared across VUs)
let _seedData = null;

export function loadSeedData() {
  if (_seedData) return _seedData;
  try {
    // v6.10.48 — wrap the relative path with import.meta.resolve() so
    // k6 stops warning about the upcoming open() resolution-base change.
    // Pre-fix open() resolved relative to the scenario entry file
    // (perf/k6/scenarios/<name>.js); k6 is migrating to resolve relative
    // to the calling module file (this one, perf/k6/lib/data.js) to
    // align with import / require semantics. Both segments happen to
    // resolve to the same target here (../../results/seed-data.json from
    // either base lands at perf/results/seed-data.json), but the
    // warning fires regardless. Using import.meta.resolve() makes the
    // base explicit, silences the warning, and works under both the
    // current and the future resolver.
    const raw = open(import.meta.resolve("../../results/seed-data.json"));
    _seedData = JSON.parse(raw);
  } catch {
    // Fallback for when seed-data.json doesn't exist yet
    _seedData = { tasks: [], participantCount: 0 };
  }
  return _seedData;
}

/**
 * Get participant credentials for a given VU index (1-based).
 */
export function getParticipant(vuId, seedData) {
  const idx = ((vuId - 1) % seedData.participantCount) + 1;
  const num = String(idx).padStart(3, "0");
  const pattern = seedData.participantEmailPattern || "perf-user-{NNN}@acme.com";
  const email = pattern.replace("{NNN}", num);
  return {
    email,
    password: seedData.participantPassword || "",
    nickname: `perf-user-${num}`,
  };
}

/**
 * Get browser-probe participant credentials for a given scenario-local
 * VU index (1-based). v6.10.60 — browser probes log in as a dedicated
 * user pool (`perf-browser-01`…) seeded in parallel with the protocol
 * pool but with a DIFFERENT email prefix.
 *
 * Why separate pools instead of the v6.10.58 "reserve IDs 301..305 in
 * the protocol pool" approach: k6's `__VU` is GLOBALLY unique across
 * scenarios, allocated in VU-creation order. Participant ramping-vus
 * begins at t=0 but takes 3 minutes to reach 300 VUs; meanwhile
 * admin / log_admin scenarios start at t=10s and t=15s, grabbing
 * global __VU slots ahead of some participants. The result: some
 * participant VUs end up with `__VU` values up to
 * `VU_COUNT + ADMIN_VUS + LOG_ADMIN_VUS` (305 in the typical run).
 * The v6.10.58 scenario's `getParticipant(__VU)` call for those
 * late-ramp participants resolved to participants 301..305 — EXACTLY
 * the IDs v6.10.58 reserved for browser probes. Browser probe login
 * kicked the protocol VU's session; the [session-401] vu=301..305
 * 47×status-poll signature in the v6.10.59 run was the diagnostic
 * proof.
 *
 * A separate email prefix is the robust cure — no shared numeric
 * range, no __VU arithmetic involved, no way for the two pools to
 * meet regardless of how k6 allocates VU IDs.
 */
export function getBrowserParticipant(vuId, seedData) {
  const count = seedData.browserParticipantCount || 0;
  if (count > 0) {
    const idx = ((vuId - 1) % count) + 1;
    const num = String(idx).padStart(2, "0");
    const pattern = seedData.browserParticipantEmailPattern || "perf-browser-{NN}@acme.com";
    const email = pattern.replace("{NN}", num);
    return {
      email,
      password: seedData.participantPassword || "",
      nickname: `perf-browser-${num}`,
    };
  }
  // Backward-compat fallback: pre-v6.10.60 seed-data.json lacks the
  // browser pool — fall through to the legacy "offset into protocol
  // pool" behaviour so old seed data still runs (collision-prone but
  // survives). A startup warn in the scenario tells the operator to
  // reseed.
  return getParticipant(vuId + (seedData.participantCount || 0), seedData);
}

/**
 * Get admin credentials for a given VU index (1-based). v6.10.85 —
 * dedicated admin pool (`perf-admin-NN`, role=admin), seeded in
 * parallel with the protocol + browser pools but under a THIRD
 * disjoint email prefix. Same rationale as getBrowserParticipant:
 * no numeric range overlap, no __VU arithmetic that can bridge two
 * pools.
 *
 * The v6.10.84 WAN run without this separation produced 633 × 403 in
 * 12 min. Three `admin` VUs + two `log_admin` VUs all logged in as
 * the SAME `superadmin` account; single-session-per-user enforcement
 * killed every prior session on each new admin login, and the admin
 * scenario's break-on-error + k6's per-iteration function invocation
 * meant admin VUs re-logged-in every iteration — continuously
 * round-robin-invalidating each other's sessions. At most one VU
 * held a live session at any moment; the other 4 polled endlessly
 * with dead sessions and every admin-endpoint call 403'd.
 *
 * With one admin account PER VU, each login only touches its own
 * user's sessions — no cross-VU kills — and a VU's fresh per-iteration
 * login only invalidates ITS own prior-iteration session (already
 * abandoned by k6's cookie-jar reset anyway), so the 4-of-5 dead-
 * session state disappears entirely.
 */
export function getAdminParticipant(vuId, seedData) {
  const count = seedData.adminParticipantCount || 0;
  if (count > 0) {
    const idx = ((vuId - 1) % count) + 1;
    const num = String(idx).padStart(2, "0");
    const pattern = seedData.adminParticipantEmailPattern || "perf-admin-{NN}@acme.com";
    const email = pattern.replace("{NN}", num);
    return {
      email,
      password: seedData.adminParticipantPassword || "",
      nickname: `perf-admin-${num}`,
    };
  }
  // Backward-compat: pre-v6.10.85 seed-data.json lacks the admin pool.
  // Fall back to the legacy shared-superadmin-login shape so old seed
  // data still runs (noisy, but survives). The scenario's init-time
  // guard promotes this case into a warn so the operator reseeds.
  return {
    email: "superadmin",
    password: seedData.adminPassword || "",
    nickname: "superadmin",
  };
}

/**
 * Shuffle an array (Fisher-Yates). Returns a new array.
 */
export function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
