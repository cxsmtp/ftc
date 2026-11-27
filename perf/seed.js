#!/usr/bin/env node
"use strict";

/**
 * Perf test data seeder.
 * Creates a competition, tasks, and participants via the API.
 * Outputs seed-data.json for k6 scripts to consume.
 *
 * Usage:
 *   node seed.js --base-url https://hack.example.com \
 *     --superadmin-password "$(cat "$DATA_DIR/.superadmin-password")" \
 *     --participant-count 50 --task-count 10 \
 *     --competition-start-offset 120 --competition-duration 10
 */

const fs = require("fs");
const path = require("path");
const defaults = require("./config");

// ── Parse CLI args ──────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function arg(name, fallback) {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : fallback;
}

const BASE_URL = arg("base-url", defaults.BASE_URL).replace(/\/+$/, "");
const SUPERADMIN_PASS = arg("superadmin-password", defaults.SUPERADMIN_PASSWORD);
const PARTICIPANT_COUNT = parseInt(arg("participant-count", defaults.PARTICIPANT_COUNT));
// v6.10.61 — auto-add a buffer of users to absorb k6's GLOBAL __VU
// allocation. k6 hands out __VU IDs across ALL scenarios from one
// shared pool, so participant VUs can end up with __VU values up to
// `VU_COUNT + ADMIN_VUS + LOG_ADMIN_VUS + ORGANISERS + BROWSER_PROBES`. The k6
// scenario picks a user via `((__VU - 1) % participantCount) + 1`;
// if participantCount < max-possible-__VU, modulo wraps and two
// protocol VUs collide on the same participant — visible as a
// back-and-forth [session-401] burst between two specific VUs that
// each kill the other's session on every login (diagnosed in the
// v6.10.60 follow-up run, where VU=5 and VU=310 both modulo'd to
// user 5 with participantCount=305).
//
// Buffer of 16 covers any sensible config (admin + log_admin +
// organiser + browser probe VUs total ≤ 16). Operators running pathological
// configs can bump --participant-count to absorb it; the k6
// scenario's init-time guard enforces the tight bound from the
// actual env vars and refuses to start otherwise.
const COLLISION_BUFFER = 16;
const PARTICIPANT_POOL_SIZE = PARTICIPANT_COUNT + COLLISION_BUFFER;
// v6.10.60 — `--browser-probes N` creates a SEPARATE pool of N users
// with a DIFFERENT email prefix (`perf-browser-NN@acme.com`) so the
// browser-probe scenario and the protocol-VU scenario can never
// resolve to the same participant. v6.10.58 attempted to reserve a
// numeric slice at the top of a single pool, but k6's globally-unique
// __VU allocation lets late-ramp protocol VUs end up with __VU values
// inside that reserved range — re-introducing the collision through a
// different path (diagnosed via the v6.10.59 attribution log).
//
// Separate email prefix is the robust cure: no arithmetic bridges the
// two pools, no k6 __VU allocation ordering can put a protocol VU
// onto a browser user.
const BROWSER_PROBES_RESERVE = Math.max(0, parseInt(arg("browser-probes", "0")) || 0);
const BROWSER_USER_PREFIX = "perf-browser-";
// v6.10.85 — `--admin-count N` creates a dedicated pool of admin
// accounts (`perf-admin-NN@acme.com`, role=admin) so the k6 admin +
// log_admin scenarios can each log in to a DISTINCT admin user. The
// v6.10.84 WAN run's 633 × 403 came from all 5 admin-capable VUs
// logging in as the same superadmin account — single-session-per-user
// enforcement (CLAUDE.md) kicked every prior session on each new
// login, leaving 4 of 5 VUs with dead sessions that 403 on every
// subsequent poll. Same solution pattern as the v6.10.60 browser pool:
// disjoint email prefix guarantees no arithmetic crossover with
// participants or browser probes, no cross-scenario session kills.
//
// v6.10.93 — sizing defaults bumped. The v6.10.85 default of 20 was
// wrong: k6's __VU is GLOBALLY allocated across every scenario, so
// admin / log_admin VUs can end up with __VU values anywhere in
// [1, VU_COUNT + ADMIN_VUS + LOG_ADMIN_VUS + ORGANISERS + BROWSER_PROBES]. At
// 300 protocol VUs that ceiling is ~310, and the k6 scenario's
// `((__VU-1) % adminPoolSize) + 1` modulo wraps with any pool smaller
// than that — two admin VUs hashing to the same account resume the
// exact 633 × 403 collision pattern v6.10.85 was meant to eliminate
// (happened live in a v6.10.92 run: vu=23 + vu=43 both mod 20 = 3 →
// both logged in as perf-admin-03, round-robin session kills).
//
// Default is now PARTICIPANT_POOL_SIZE — same size + same
// collision-buffer as the participant pool, so __VU values up to the
// global ceiling all map to distinct admin accounts. Explicit
// `--admin-count N` still overrides. Set `--admin-count 0` only if
// ADMIN_VUS=0 + LOG_ADMIN_VUS=0 + ORGANISERS=0 on the k6 command (no
// admin-capable VUs to seed for; ORGANISERS defaults to 3).
const ADMIN_POOL_SIZE = Math.max(0, parseInt(arg("admin-count", String(PARTICIPANT_POOL_SIZE))) || 0);
const ADMIN_USER_PREFIX = "perf-admin-";
const TASK_COUNT = parseInt(arg("task-count", defaults.TASK_COUNT));
const COMP_START_OFFSET = parseInt(arg("competition-start-offset", defaults.COMPETITION_START_OFFSET_S));
const COMP_DURATION = parseInt(arg("competition-duration", defaults.COMPETITION_DURATION_MIN));
const BG_USERS = parseInt(arg("bg-users", "5000"));
const BG_TASKS = parseInt(arg("bg-tasks", "300"));
const SKIP_BG = args.includes("--skip-bg");
// Historical-competition seeding (Phase 0b). Makes the submissions /
// hint_reveals / challenge_events / competition_events / competition_users
// tables + the competitions list production-sized so the admin polling reads
// are benchmarked against a populated DB. Each comp is ENDED (past dates) and
// samples a fresh subset of the BG-user pool; every sampled participant solves
// every assigned task (+ some wrong/hint history). See bulk-seed-history.
const HISTORY_COMPS = parseInt(arg("history-comps", "100"));
const HISTORY_PARTICIPANTS = parseInt(arg("history-participants", "200"));
const HISTORY_TASKS_PER = parseInt(arg("history-tasks-per", "10"));
const HISTORY_TASK_POOL = parseInt(arg("history-task-pool", "40"));
// Competitions per bulk-seed-history REQUEST. The whole history is sent in
// batches of this many comps so no single request is large enough to trip a
// reverse-proxy read timeout (502/504). 10 comps × 200 participants × 10 tasks
// ≈ a few seconds server-side. Lower it if the target sits behind a tight
// proxy timeout; raise it (toward the endpoint's 4M work-unit cap) on a direct
// connection.
const HISTORY_BATCH = Math.max(1, parseInt(arg("history-batch", "10")) || 10);
// Per-request abort timeout (ms) for the history batches only — a hung proxy
// connection aborts instead of wedging the seed before the protocol pool is
// created. The history phase is non-fatal, so an abort just skips the rest.
const HISTORY_REQ_TIMEOUT_MS = Math.max(10_000, parseInt(arg("history-req-timeout-ms", "180000")) || 180000);
const SKIP_HISTORY = args.includes("--skip-history");
const EMAIL_DOMAIN = defaults.PARTICIPANT_EMAIL_DOMAIN;
const USER_PREFIX = defaults.PARTICIPANT_PREFIX;
const BG_USER_PREFIX = "bg-user-";
const CONCURRENCY = parseInt(arg("concurrency", "10"));
const MAINTENANCE_BYPASS = arg("maintenance-bypass", process.env.MAINTENANCE_BYPASS || "");
const CONFIRM_LIVE = args.includes("--confirm-live");

// ── Safety guards (v6.10.18) ────────────────────────────────────────────────
// Guard 1: explicit confirmation flag. Any code path that reaches this
// file — `node seed.js`, `node -e "require('./seed.js')"`, a stray
// import in an unrelated harness — aborts here unless the operator
// has typed `--confirm-live` on the CLI. Single door, closed by
// default. Fatal before any network activity.
if (!CONFIRM_LIVE) {
  console.error("REFUSING TO RUN — pass --confirm-live to acknowledge this script will mutate the target server.");
  console.error("See perf/README.md § Prerequisites before running.");
  process.exit(1);
}

// Guard 2: maintenance bypass must be set. Perf runs go through the
// maintenance gate by protocol — an empty bypass token means the
// target is almost certainly production, not a quarantined perf box.
if (!MAINTENANCE_BYPASS) {
  console.error("REFUSING TO RUN — MAINTENANCE_BYPASS is empty.");
  console.error("The perf target must have a .maintenance file on its data volume; pass the token via");
  console.error("--maintenance-bypass <TOKEN> or MAINTENANCE_BYPASS=<TOKEN>.");
  process.exit(1);
}

console.log(`Seeding perf data:
  URL:            ${BASE_URL}
  Participants:   ${PARTICIPANT_POOL_SIZE} created (${PARTICIPANT_COUNT} --participant-count + ${COLLISION_BUFFER} buffer for global __VU allocation)
                  protocol pool: ${USER_PREFIX}NNN@${EMAIL_DOMAIN}
  Browser probes: ${BROWSER_PROBES_RESERVE > 0 ? `${BROWSER_PROBES_RESERVE} (separate pool: ${BROWSER_USER_PREFIX}NN@${EMAIL_DOMAIN})` : "0"}
  Admin pool:     ${ADMIN_POOL_SIZE > 0 ? `${ADMIN_POOL_SIZE} (separate pool: ${ADMIN_USER_PREFIX}NN@${EMAIL_DOMAIN}, role=admin)` : "0"}
  Tasks:          ${TASK_COUNT}
  Comp start:     now + ${COMP_START_OFFSET}s
  Comp duration:  ${COMP_DURATION} min
  Background:     ${SKIP_BG ? "SKIPPED" : `${BG_USERS} users, ${BG_TASKS} tasks`}
  History:        ${SKIP_HISTORY ? "SKIPPED" : `${HISTORY_COMPS} ended comps × ${HISTORY_PARTICIPANTS} participants × ${HISTORY_TASKS_PER}/${HISTORY_TASK_POOL} tasks (${HISTORY_BATCH}/request, non-fatal)`}
  Concurrency:    ${CONCURRENCY}
`);

// ── HTTP helpers ────────────────────────────────────────────────────────────
async function api(method, path, body, headers = {}, timeoutMs) {
  const url = `${BASE_URL}${path}`;
  const opts = { method, headers: { ...headers }, redirect: "manual" };
  if (MAINTENANCE_BYPASS) opts.headers["x-maintenance-bypass"] = MAINTENANCE_BYPASS;
  if (body) {
    opts.body = JSON.stringify(body);
    opts.headers["content-type"] = "application/json";
  }
  // Optional per-request abort timeout (used by the history batches; all other
  // callers pass no timeout and keep the original unbounded behaviour).
  let timer;
  if (timeoutMs) {
    const ac = new AbortController();
    opts.signal = ac.signal;
    timer = setTimeout(() => ac.abort(), timeoutMs);
  }
  try {
    const res = await fetch(url, opts);
    // Capture set-cookie for session
    const cookies = res.headers.getSetCookie?.() || [];
    return { status: res.status, cookies, json: async () => res.json().catch(() => ({})), text: async () => res.text() };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

class Session {
  constructor() { this.cookies = []; this.csrf = ""; }

  cookieHeader() {
    return this.cookies.map(c => c.split(";")[0]).join("; ");
  }

  async request(method, path, body, timeoutMs) {
    const headers = { cookie: this.cookieHeader() };
    if (this.csrf) headers["x-csrf-token"] = this.csrf;
    const res = await api(method, path, body, headers, timeoutMs);
    // Merge new cookies
    for (const c of res.cookies) {
      const name = c.split("=")[0];
      this.cookies = this.cookies.filter(x => !x.startsWith(name + "="));
      this.cookies.push(c);
    }
    return res;
  }

  async fetchCsrf() {
    const res = await this.request("GET", "/api/csrf-token");
    const d = await res.json();
    this.csrf = d.csrfToken || d.token || "";
    return this.csrf;
  }

  async login(email, password) {
    await this.fetchCsrf();
    const res = await this.request("POST", "/api/login", { email, password });
    // The status only: the address and the response body stay out of the
    // error (and so out of any log or CI output it reaches).
    if (res.status !== 200) throw new Error(`Login failed: ${res.status}`);
    await this.fetchCsrf(); // re-fetch after session.regenerate
    return res.json();
  }
}

// ── Batch helper ────────────────────────────────────────────────────────────
async function batch(items, concurrency, fn) {
  for (let i = 0; i < items.length; i += concurrency) {
    await Promise.all(items.slice(i, i + concurrency).map(fn));
  }
}

// ── Task generation ─────────────────────────────────────────────────────────
function generateTasks(count, prefix = "Perf Task", answerPrefix = "perf-answer") {
  const tasks = [];
  let easy, med, hard;
  if (count <= 10) { easy = 3; med = 4; hard = count - 7; }
  else if (count <= 20) { easy = Math.round(count * 0.33); med = Math.round(count * 0.4); hard = count - easy - med; }
  else { easy = Math.round(count * 0.33); med = Math.round(count * 0.4); hard = count - easy - med; }

  for (let i = 0; i < count; i++) {
    let diff;
    if (i < easy) diff = "easy";
    else if (i < easy + med) diff = "medium";
    else diff = "hard";
    tasks.push({
      title: `${prefix} ${String(i + 1).padStart(3, "0")} (${diff})`,
      description: `<p>Task #${i + 1}. Difficulty: ${diff}.</p><p>Solve by providing the correct answer below.</p>`,
      difficulty: diff,
      answer_type: "text",
      correct_answer: `${answerPrefix}-${i + 1}`,
      explanation: `<p>The correct answer is ${answerPrefix}-${i + 1}.</p>`,
      hint: `The answer starts with "${answerPrefix}-"`,
      status: "published",
    });
  }
  return tasks;
}

// ── Pre-flight: verify the target IS in maintenance mode ───────────────────
// A fetch to /api/config WITHOUT the bypass header should be served the
// 503 maintenance gate. Anything else means the `.maintenance` file
// isn't on the data volume — either the operator forgot to place it,
// the container is pointing at the wrong volume, or the target is
// genuinely production. Aborting before any mutating call prevents
// the exact accident this guard was added for.
async function preflightMaintenanceGate() {
  const res = await fetch(`${BASE_URL}/api/config`, { redirect: "manual" });
  if (res.status !== 503) {
    console.error(`REFUSING TO RUN — ${BASE_URL} is NOT in maintenance mode.`);
    console.error(`  GET /api/config without X-Maintenance-Bypass returned ${res.status}; expected 503.`);
    console.error(`  Create DATA_DIR/.maintenance on the target with the bypass token first.`);
    console.error(`  See perf/README.md § Maintenance gate.`);
    process.exit(1);
  }
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  await preflightMaintenanceGate();
  const s = new Session();
  await s.login("superadmin", SUPERADMIN_PASS);
  console.log("Logged in as superadmin.");

  // ── Phase 0: Background data (simulates production-like DB size) ──────────
  if (!SKIP_BG) {
    console.log(`\n── Populating background data: ${BG_TASKS} tasks, ${BG_USERS} users ──`);

    // Background tasks (draft, not assigned to any competition)
    let bgTasksCreated = 0;
    const bgTaskDefs = generateTasks(BG_TASKS, "BG Task", "bg-answer");
    // Create as drafts so they don't interfere with competitions
    for (const def of bgTaskDefs) def.status = "draft";
    await batch(bgTaskDefs, CONCURRENCY, async (def) => {
      const res = await s.request("POST", "/api/admin/tasks", def);
      if (res.status === 200) bgTasksCreated++;
    });
    console.log(`  Background tasks created: ${bgTasksCreated}`);

    // Background users — v6.10.80 — single bulk-seed call replaces the
    // v6.10.79 parallel-batch /api/register loop + the separate verify/
    // approve loop. ~10 min → ~1 s for BG_USERS=5000.
    const bgUserPayload = [];
    for (let i = 1; i <= BG_USERS; i++) {
      const num = String(i).padStart(4, "0");
      bgUserPayload.push({
        firstName: "BG", lastName: `User${num}`, nickname: `${BG_USER_PREFIX}${num}`,
        email: `${BG_USER_PREFIX}${num}@${EMAIL_DOMAIN}`,
        company: "Background Corp", title: "Background",
        country: "US", timezone: "America/New_York",
        job_function: "Software Developer / Engineer", city: "New York",
        avatar: "default1",
      });
    }
    const bgRes = await s.request("POST", "/api/admin/perf/bulk-seed-users", {
      users: bgUserPayload,
    });
    const bgBody = await bgRes.json();
    if (bgRes.status !== 200) throw new Error(`bulk-seed BG failed: ${bgRes.status} ${JSON.stringify(bgBody)}`);
    console.log(`  Background users: ${bgBody.inserted} created, ${bgBody.skipped} already existed (verified+approved in-line).`);
    console.log(`── Background population complete ──\n`);
  }

  // ── Phase 0b: Historical competitions + submission history ───────────────
  // Make the history tables look like a platform that has run many events:
  // N ended competitions, each with a sampled subset of the BG-user pool that
  // solved every assigned task (+ some wrong/hint history). The heavy inserts
  // run server-side via /api/admin/perf/bulk-seed-history — going through
  // /api/tasks/:id/submit comps×participants×tasks times would take hours.
  //
  // v7.2.x — this phase is SUPPLEMENTARY (it only sizes the admin-read tables);
  // it must NEVER abort the perf-test setup. Two hardening changes after a real
  // run where a fresh-DB seed died here and left k6 logging into non-existent
  // protocol users:
  //   1. NON-FATAL — the whole phase is wrapped so any error (or a per-request
  //      abort) logs a warning and the seed continues to create the test
  //      competition + protocol pool + seed-data.json regardless.
  //   2. BATCHED — the comps are seeded HISTORY_BATCH at a time. A single
  //      request for all 100×200×10 comps is ~1M inserts and can exceed a
  //      reverse-proxy read timeout (502/504); each small batch is a few
  //      seconds and proxy-safe. A failing batch stops the history phase
  //      without failing the run.
  // The history-task pool is PUBLISHED tasks distinct from the BG drafts and
  // the live test comp's tasks, so nothing leaks into the live run.
  if (!SKIP_HISTORY) {
    try {
      console.log(`── Seeding history: ${HISTORY_COMPS} ended comps × ${HISTORY_PARTICIPANTS} participants × ${HISTORY_TASKS_PER} tasks (pool ${HISTORY_TASK_POOL}), ${HISTORY_BATCH} comps/request ──`);

      // Published task pool the historical comps draw from.
      const histTaskDefs = generateTasks(HISTORY_TASK_POOL, "History Task", "history-answer");
      const histTaskIds = [];
      await batch(histTaskDefs, CONCURRENCY, async (def) => {
        const r = await s.request("POST", "/api/admin/tasks", def);
        if (r.status === 200) {
          const d = await r.json();
          if (d.id) histTaskIds.push(d.id);
        }
      });
      console.log(`  History task pool created: ${histTaskIds.length}/${HISTORY_TASK_POOL} published tasks.`);

      if (histTaskIds.length === 0) {
        console.warn("  No history tasks created — skipping history seed.");
      } else {
        const totals = { comps: 0, cu: 0, subs: 0, hints: 0, chev: 0, compev: 0 };
        const t0 = Date.now();
        let remaining = HISTORY_COMPS, batchNo = 0;
        while (remaining > 0) {
          const n = Math.min(HISTORY_BATCH, remaining);
          batchNo++;
          const histRes = await s.request("POST", "/api/admin/perf/bulk-seed-history", {
            competitions: n,
            participantsPer: HISTORY_PARTICIPANTS,
            tasksPer: HISTORY_TASKS_PER,
            taskIds: histTaskIds,
            // Sample the historical participants from the BG-user pool only — the
            // perf-NNN protocol pool is reserved for the live k6 run.
            participantEmailPrefix: BG_USER_PREFIX,
            // Distinct prefix per batch so the competitions list shows a
            // continuous series rather than repeated 001..N for every batch.
            namePrefix: `Perf History B${String(batchNo).padStart(2, "0")}`,
          }, HISTORY_REQ_TIMEOUT_MS);
          const b = await histRes.json();
          if (histRes.status !== 200) {
            console.warn(`  History batch ${batchNo} failed (${histRes.status}): ${JSON.stringify(b)} — stopping history seed (perf test continues).`);
            break;
          }
          totals.comps += b.competitions_created || 0;
          totals.cu += b.competition_users || 0;
          totals.subs += b.submissions || 0;
          totals.hints += b.hint_reveals || 0;
          totals.chev += b.challenge_events || 0;
          totals.compev += b.competition_events || 0;
          remaining -= n;
          console.log(`  History batch ${batchNo}: +${b.competitions_created} comps (${totals.comps}/${HISTORY_COMPS}), ${b.submissions} subs in ${b.elapsed_ms}ms.`);
        }
        console.log(`  History seeded in ${Date.now() - t0}ms: ${totals.comps} comps, ${totals.cu} memberships, ` +
          `${totals.subs} submissions, ${totals.hints} hint-reveals, ${totals.chev} challenge-events, ${totals.compev} competition-events.`);
      }
      console.log(`── History population complete ──\n`);
    } catch (e) {
      console.warn(`── History seed errored (${e && e.message ? e.message : e}) — continuing WITHOUT full history; the perf-test setup (test competition + protocol pool) is unaffected. ──\n`);
    }
  }

  // ── Phase 1: Test competition ────────────────────────────────────────────
  // Create competition
  const startTime = new Date(Date.now() + COMP_START_OFFSET * 1000).toISOString();
  const compRes = await s.request("POST", "/api/admin/competitions", {
    name: `Perf Test ${new Date().toISOString().slice(0, 16)}`,
    start_time: startTime,
    duration_minutes: COMP_DURATION,
  });
  const compData = await compRes.json();
  const compId = compData.competition?.id || compData.id;
  if (!compId) throw new Error("Failed to create competition: " + JSON.stringify(compData));
  console.log(`Competition created: ${compId} (starts in ${COMP_START_OFFSET}s, duration ${COMP_DURATION}min)`);

  // Create and assign tasks
  const taskDefs = generateTasks(TASK_COUNT);
  const tasks = [];
  for (const def of taskDefs) {
    const res = await s.request("POST", "/api/admin/tasks", def);
    const d = await res.json();
    if (!d.id) throw new Error("Failed to create task: " + JSON.stringify(d));
    tasks.push({ id: d.id, title: def.title, difficulty: def.difficulty, correct_answer: def.correct_answer });
    // Assign to competition
    await s.request("POST", `/api/admin/tasks/${d.id}/competitions`, { competitionIds: [compId] });
  }
  console.log(`${tasks.length} tasks created and assigned.`);

  // v6.10.80 — protocol-pool users via bulk-seed. Replaces the
  // v6.10.79 parallel /api/register loop + the separate verify /
  // approve / reset-password / competition-assign loops. One request
  // creates all users as verified+approved, assigns them to the
  // competition, and sets the shared password via a single bcrypt
  // hash — a process that previously took 60-90 s drops to <1 s.
  // PARTICIPANT_POOL_SIZE = PARTICIPANT_COUNT + COLLISION_BUFFER
  // (v6.10.61 — ensures the seed has enough users to absorb k6's
  // global __VU allocation across all scenarios).
  const protocolPayload = [];
  for (let i = 1; i <= PARTICIPANT_POOL_SIZE; i++) {
    const num = String(i).padStart(3, "0");
    protocolPayload.push({
      firstName: "Perf", lastName: `User${num}`, nickname: `${USER_PREFIX}${num}`,
      email: `${USER_PREFIX}${num}@${EMAIL_DOMAIN}`,
      company: "PerfTest Inc", title: "Tester",
      country: "US", timezone: "America/New_York",
      job_function: "Software Developer / Engineer", city: "New York",
      avatar: "default1",
    });
  }
  const protocolRes = await s.request("POST", "/api/admin/perf/bulk-seed-users", {
    users: protocolPayload, competitionId: compId,
  });
  const protocolBody = await protocolRes.json();
  if (protocolRes.status !== 200) throw new Error(`bulk-seed protocol failed: ${protocolRes.status} ${JSON.stringify(protocolBody)}`);
  // v6.13.9 — bulk-seed now re-enrolls skipped (pre-existing) users
  // into the caller's competition via INSERT OR IGNORE. Call that
  // out in the log so a rerun against the same perf DB shows whether
  // the enrolment gap was filled — previously the "skipped" count
  // silently implied "unchanged membership" which wasn't true.
  const enrolledX = protocolBody.enrolled_existing || 0;
  console.log(`Protocol participants: ${protocolBody.inserted} created, ${protocolBody.skipped} already existed (of which ${enrolledX} enrolled into this competition), ${PARTICIPANT_COUNT} requested + ${COLLISION_BUFFER} buffer.`);

  // v6.10.85 — admin pool. Each row carries `role: "admin"` so the
  // bulk-seed endpoint stamps admin on insert. No competition
  // assignment — admins don't need a competition scope to hit
  // /api/admin/* endpoints. Skipped when ADMIN_POOL_SIZE=0.
  let adminBody = { inserted: 0, skipped: 0, total: 0 };
  if (ADMIN_POOL_SIZE > 0) {
    const adminPayload = [];
    for (let i = 1; i <= ADMIN_POOL_SIZE; i++) {
      const num = String(i).padStart(2, "0");
      adminPayload.push({
        firstName: "Perf", lastName: `Admin${num}`, nickname: `${ADMIN_USER_PREFIX}${num}`,
        email: `${ADMIN_USER_PREFIX}${num}@${EMAIL_DOMAIN}`,
        company: "PerfTest Inc", title: "Admin",
        country: "US", timezone: "America/New_York",
        job_function: "Software Developer / Engineer", city: "New York",
        avatar: "default1",
        role: "admin",
      });
    }
    const adminRes = await s.request("POST", "/api/admin/perf/bulk-seed-users", {
      users: adminPayload,
    });
    adminBody = await adminRes.json();
    if (adminRes.status !== 200) throw new Error(`bulk-seed admin failed: ${adminRes.status} ${JSON.stringify(adminBody)}`);
    console.log(`Admin pool:   ${adminBody.inserted} created, ${adminBody.skipped} already existed (${ADMIN_POOL_SIZE} requested, role=admin, not assigned to competition).`);
  }

  // Browser-probe pool — same shape, different email prefix so k6's
  // browserScenario can never resolve to a protocol-pool user via
  // __VU arithmetic (v6.10.60 rationale). Skipped when
  // BROWSER_PROBES_RESERVE = 0.
  let browserBody = { inserted: 0, skipped: 0, total: 0 };
  if (BROWSER_PROBES_RESERVE > 0) {
    const browserPayload = [];
    for (let i = 1; i <= BROWSER_PROBES_RESERVE; i++) {
      const num = String(i).padStart(2, "0");
      browserPayload.push({
        firstName: "Perf", lastName: `Browser${num}`, nickname: `${BROWSER_USER_PREFIX}${num}`,
        email: `${BROWSER_USER_PREFIX}${num}@${EMAIL_DOMAIN}`,
        company: "PerfTest Inc", title: "Browser Probe",
        country: "US", timezone: "America/New_York",
        job_function: "Software Developer / Engineer", city: "New York",
        avatar: "default1",
      });
    }
    const browserRes = await s.request("POST", "/api/admin/perf/bulk-seed-users", {
      users: browserPayload, competitionId: compId,
    });
    browserBody = await browserRes.json();
    if (browserRes.status !== 200) throw new Error(`bulk-seed browser failed: ${browserRes.status} ${JSON.stringify(browserBody)}`);
    const enrolledBr = browserBody.enrolled_existing || 0;
    console.log(`Browser-probe participants: ${browserBody.inserted} created, ${browserBody.skipped} already existed (of which ${enrolledBr} enrolled into this competition).`);
  }

  // Pull the list of seeded perf users back from the admin participants
  // endpoint so seed-data.json's `participantCount` reflects actual
  // pool sizes (including any skipped-as-already-existing users from a
  // prior seed). Smaller query now since bulk-seed bypassed the
  // per-user admin round-trips — just a single scoped read for the
  // seed-manifest output below.
  let page = 1;
  const allUsers = [];
  while (true) {
    const res = await s.request("GET", `/api/admin/participants?limit=5000&page=${page}`);
    const d = await res.json();
    allUsers.push(...(d.participants || []));
    if (allUsers.length >= d.total || (d.participants || []).length === 0) break;
    page++;
  }
  const perfUsers = allUsers.filter(u =>
    u.email.startsWith(USER_PREFIX) ||
    u.email.startsWith(BROWSER_USER_PREFIX) ||
    u.email.startsWith(ADMIN_USER_PREFIX)
  );
  // v6.10.60 — split the merged perfUsers list back into the pools for
  // the seed-data manifest. The protocol pool is what k6's
  // `getParticipant(__VU)` resolves against; the browser pool is what
  // `getBrowserParticipant(__VU)` resolves against. v6.10.85 — admin
  // pool is what `getAdminParticipant(__VU)` resolves against. Three
  // disjoint email prefixes guarantee no overlap regardless of how k6
  // allocates __VU values across scenarios.
  const protocolUsers = perfUsers.filter(u => u.email.startsWith(USER_PREFIX));
  const browserUsers  = perfUsers.filter(u => u.email.startsWith(BROWSER_USER_PREFIX));
  const adminUsers    = perfUsers.filter(u => u.email.startsWith(ADMIN_USER_PREFIX));

  // Output seed data
  const seedData = {
    baseUrl: BASE_URL,
    competitionId: compId,
    competitionStart: startTime,
    competitionDurationMin: COMP_DURATION,
    tasks: tasks.map(t => ({ id: t.id, difficulty: t.difficulty, correctAnswer: t.correct_answer })),
    participantCount: protocolUsers.length,
    participantEmailPattern: `${USER_PREFIX}{NNN}@${EMAIL_DOMAIN}`,
    // v6.10.60 — the new browser-probe pool. Absent when
    // BROWSER_PROBES_RESERVE was 0; the k6 scenario's startup warn
    // surfaces this case so the operator knows browser probes will
    // fall back to the (collision-prone) shared-pool behaviour.
    browserParticipantCount: browserUsers.length,
    browserParticipantEmailPattern: BROWSER_PROBES_RESERVE > 0
      ? `${BROWSER_USER_PREFIX}{NN}@${EMAIL_DOMAIN}`
      : undefined,
    // v6.10.85 — admin pool manifest. Absent when ADMIN_POOL_SIZE was
    // 0; the k6 scenario's init-time guard then falls back to the
    // legacy shared-superadmin login (with the known single-session
    // collision noise). adminPassword is re-exported as
    // adminParticipantPassword for symmetry with the participant pool
    // shape so getAdminParticipant can return {email,password}.
    adminParticipantCount: adminUsers.length,
    adminParticipantEmailPattern: ADMIN_POOL_SIZE > 0
      ? `${ADMIN_USER_PREFIX}{NN}@${EMAIL_DOMAIN}`
      : undefined,
    adminPassword: SUPERADMIN_PASS,
  };

  const outPath = path.join(__dirname, "results", "seed-data.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  // 0600: the file carries the built-in superadmin's boot-generated password
  // (adminPassword), the same credential DATA_DIR/.superadmin-password holds
  // at 0600, so k6 can sign the admin scenarios in.
  fs.writeFileSync(outPath, JSON.stringify(seedData, null, 2), { mode: 0o600 });
  console.log(`\nSeed data written to ${outPath}`);
  console.log(`Competition starts at: ${startTime}`);
  console.log(`Run k6 test within ${COMP_START_OFFSET}s to catch the login phase.`);
}

main().catch(e => { console.error("Seed failed:", e.message); process.exit(1); });
