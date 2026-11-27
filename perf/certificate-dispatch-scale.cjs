#!/usr/bin/env node
"use strict";

// v8.15.1 — MEASURE the automatic certificate dispatch at event scale.
//
//   node perf/certificate-dispatch-scale.cjs [participants=3000] [port=7999]
//
// Spawns its own server (NODE_ENV=test, scratch DATA_DIR / UPLOADS_DIR) against an
// in-process capturing SMTP relay, creates one ended event of N participants
// (three solvers, everybody else one wrong answer — so every one of them earns a
// certificate), then drives `POST /api/test/certificate-dispatch-tick {force}`
// until the job is drained. Prints per-pass time, sends and board builds, and the
// totals. The participants are SEEDED BY SQL (3000 sign-ups through the API would
// measure registration, not the dispatcher); the event, the task, the end and the
// dispatch all go through the real routes.
//
// Never run against a real deployment: it needs the test-only tick.
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { startSmtpCapture } = require("../tests/smtp-capture");

const N = parseInt(process.argv[2], 10) || 3000;
const PORT = parseInt(process.argv[3], 10) || 7999;
const BASE = `http://127.0.0.1:${PORT}`;

function client() {
  const jar = [];
  const call = async (method, p, data, headers = {}) => {
    const r = await fetch(BASE + p, {
      method,
      headers: { "content-type": "application/json", ...(jar.length ? { cookie: jar.join("; ") } : {}), ...headers },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    for (const c of (r.headers.getSetCookie ? r.headers.getSetCookie() : [])) {
      const kv = c.split(";")[0], k = kv.split("=")[0];
      const i = jar.findIndex(x => x.startsWith(k + "="));
      if (i >= 0) jar[i] = kv; else jar.push(kv);
    }
    const t = await r.text();
    let body = t; try { body = JSON.parse(t); } catch (_) {}
    return { status: r.status, ok: r.ok, body, text: t };
  };
  return {
    get: (p) => call("GET", p),
    post: (p, d, h) => call("POST", p, d, h),
    async h() { return { "x-csrf-token": (await call("GET", "/api/csrf-token")).body.csrfToken }; },
  };
}

(async () => {
  const smtp = await startSmtpCapture();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "certscale-"));
  const uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), "certscale-up-"));
  const child = spawn(process.execPath, ["server.js"], {
    cwd: path.resolve(__dirname, ".."),
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: "test",
      PORT: String(PORT), DATA_DIR: dataDir, UPLOADS_DIR: uploadsDir, BASE_URL: BASE,
      SMTP_HOST: "127.0.0.1", SMTP_PORT: String(smtp.port), SMTP_ALLOW_PLAINTEXT: "1",
      SUPERADMIN_PASSWORD_QUIET: "1", RATE_LIMIT_DISABLED: "1", NODE_OPTIONS: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", d => { out += d; });
  child.stderr.on("data", d => { out += d; });
  const cleanup = () => {
    try { child.kill("SIGKILL"); } catch (_) {}
    smtp.close().catch(() => {});
    for (const d of [dataDir, uploadsDir]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} }
  };
  try {
    const t0 = Date.now();
    for (;;) {
      try { if ((await fetch(`${BASE}/api/config`)).ok) break; } catch (_) {}
      if (Date.now() - t0 > 40000) throw new Error("server never became ready:\n" + out.slice(-2000));
      await new Promise(r => setTimeout(r, 200));
    }
    const pass = fs.readFileSync(path.join(dataDir, ".superadmin-password"), "utf8").trim();
    const sa = client();
    if (!(await sa.post("/api/login", { email: "superadmin", password: pass }, await sa.h())).ok) throw new Error("login failed");
    const start = new Date(Date.now() - 30 * 60_000);
    const cr = await sa.post("/api/admin/competitions", {
      name: `Scale ${N}`, event_kind: "tournament", start_time: start.toISOString(), duration_minutes: 600, timezone: "UTC",
    }, await sa.h());
    if (!cr.ok) throw new Error("create: " + cr.text);
    const compId = cr.body.competition.id;
    const tr = await sa.post("/api/admin/tasks", {
      title: "Scale task", description: "<p>d</p>", difficulty: "easy", answer_type: "text", correct_answer: "x", status: "published",
    }, await sa.h());
    const taskId = tr.body.id;
    await sa.post(`/api/admin/tasks/${taskId}/competitions`, { competitionIds: [compId] }, await sa.h());

    // Seed N participants, their membership and one graded answer each.
    const Database = require("better-sqlite3");
    const db = new Database(path.join(dataDir, "hackathon.db"));
    db.pragma("busy_timeout = 10000");
    const seedT = Date.now();
    db.transaction(() => {
      const iu = db.prepare(`INSERT INTO users (id, first_name, last_name, nickname, email, company, title, country, timezone,
        job_function, city, verified, approved, role, created_at) VALUES (?,?,?,?,?,'Acme','Eng','US','UTC','Engineer','NYC',1,1,'participant',?)`);
      const im = db.prepare(`INSERT INTO competition_users (competition_id, user_id, login_time, assigned_at, direct_assigned) VALUES (?,?,?,?,1)`);
      const is = db.prepare(`INSERT INTO submissions (id, user_id, task_id, competition_id, answer, is_correct, points_delta, submitted_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?)`);
      const now = new Date().toISOString();
      for (let i = 0; i < N; i++) {
        const id = crypto.randomUUID();
        iu.run(id, "Scale", `Person${i}`, `scale${i}`, `scale${i}@company.co`, now);
        const login = new Date(start.getTime() + 60_000 + i * 50).toISOString();
        im.run(compId, id, login, login);
        const ok = i < 3;
        const at = new Date(start.getTime() + 120_000 + i * 50).toISOString();
        is.run(crypto.randomUUID(), id, taskId, compId, ok ? "x" : "no", ok ? 1 : 0, ok ? 50 : -5, at, at);
      }
    })();
    db.close();
    console.log(`seeded ${N} participants in ${Date.now() - seedT} ms`);

    const end = await sa.post(`/api/admin/competitions/${compId}/end-now`, {}, await sa.h());
    if (!end.ok) throw new Error("end-now: " + end.text);

    const passes = [];
    const allT = Date.now();
    for (let k = 0; k < 1000; k++) {
      const t = Date.now();
      const r = await sa.post("/api/test/certificate-dispatch-tick", { force: true }, await sa.h());
      if (!r.ok) throw new Error("tick: " + r.text);
      passes.push({ ms: Date.now() - t, ...r.body });
      console.log(`pass ${k + 1}: ${Date.now() - t} ms  issued=${r.body.issued} sent=${r.body.sent} failed=${r.body.failed} boardBuilds=${r.body.boardBuilds} jobs=${r.body.jobs}`);
      if (!r.body.jobs) break;
    }
    const total = Date.now() - allT;
    const sent = passes.reduce((a, p) => a + (p.sent || 0), 0);
    const builds = passes.reduce((a, p) => a + (p.boardBuilds || 0), 0);
    console.log(JSON.stringify({ participants: N, passes: passes.length - 1, totalMs: total, firstPassMs: passes[0].ms,
      sent, mailsCaptured: smtp.messages.filter(m => /certificate/i.test(m.header("subject") || "")).length,
      boardBuilds: builds, msPerCertificate: Math.round(total / Math.max(1, sent)) }));
  } finally {
    cleanup();
  }
})().catch((e) => { console.error(e); process.exit(1); });
