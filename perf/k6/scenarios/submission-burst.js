/**
 * Focused stress test: burst of concurrent submissions.
 * Tests SQLite write contention and the O(P) auto-end check.
 *
 * All VUs login, select competition, then submit simultaneously.
 *
 * Usage:
 *   k6 run --env BASE_URL=https://hack.example.com \
 *          --env VU_COUNT=50 \
 *          submission-burst.js
 */

import { sleep } from "k6";
import { loginParticipant } from "../lib/auth.js";
import { get, safeJson } from "../lib/http.js";
import { mutateWithRetry } from "../lib/csrf.js";
import { loadSeedData, getParticipant } from "../lib/data.js";
import { submitAnswer, taskDetail, correctSubmissions, wrongSubmissions, staleSubmissions, sqliteBusyErrors } from "../lib/metrics.js";

const BASE_URL = __ENV.BASE_URL || "https://localhost:3000";
const VU_COUNT = parseInt(__ENV.VU_COUNT || "50");

const seedData = loadSeedData();

export const options = {
  scenarios: {
    submission_burst: {
      executor: "per-vu-iterations",
      vus: VU_COUNT,
      iterations: 1,
      maxDuration: "5m",
      exec: "default",
    },
  },
  thresholds: {
    "submit_answer": ["p(90)<3000", "p(95)<5000", "avg<2000"],
    "http_req_failed": ["rate<0.02"],
    "sqlite_busy_errors": ["count<5"],
    // v8.9.1 — a refused-to-grade submit is a harness defect, never load. This
    // is the gate that was missing when every submit 409'd for eleven releases.
    "stale_submissions": ["count<1"],
  },
};

export default function () {
  const participant = getParticipant(__VU, seedData);
  const { csrfToken, ok } = loginParticipant(BASE_URL, participant.email, participant.password);
  if (!ok) return;

  let csrf = csrfToken;

  // Select competition
  const compRes = mutateWithRetry("post", `${BASE_URL}/api/select-competition`,
    { competitionId: seedData.competitionId }, csrf, BASE_URL);
  if (compRes._newCsrfToken) csrf = compRes._newCsrfToken;

  // Small random delay to slightly stagger (0-2s)
  sleep(Math.random() * 2);

  // Submit answers to all tasks in rapid succession
  for (const task of seedData.tasks) {
    // v8.9.1 — the submit route REQUIRES the challenge's grading hash (since
    // v7.20.9), which only the detail payload carries; without it every submit
    // below was refused 409 `task_changed` and this scenario measured a refusal
    // path while reporting a plausible correct/wrong split. One detail GET per
    // task is what a real participant does before answering, so the burst now
    // measures the same path the SPA takes.
    const detailRes = get(`${BASE_URL}/api/tasks/${task.id}`, { tags: { name: "task-detail" } });
    taskDetail.add(detailRes.timings.duration);
    const detail = safeJson(detailRes) || {};
    const gradingHash = detail.grading_hash || "";
    // 70% correct, 30% wrong
    const answer = Math.random() < 0.7 ? task.correctAnswer : `wrong-${Math.random().toString(36).slice(2)}`;
    const res = mutateWithRetry("post", `${BASE_URL}/api/tasks/${task.id}/submit`,
      { answer, gradingHash }, csrf, BASE_URL, { name: "submit-answer" });
    submitAnswer.add(res.timings.duration);
    if (res._newCsrfToken) csrf = res._newCsrfToken;

    if (res.status >= 500) sqliteBusyErrors.add(1);
    const body = res.json() || {};
    if (res.status === 409 && body.task_changed) staleSubmissions.add(1);
    else if (body.correct) correctSubmissions.add(1);
    else wrongSubmissions.add(1);

    // Brief pause between submissions (1-5s)
    sleep(1 + Math.random() * 4);
  }
}
