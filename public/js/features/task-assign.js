"use strict";

// ── THE ONE "put these challenges on that event" path ────────────────────────
//
// Used by the Add challenges dialog (challenges-admin.js `assignPickedTasks`)
// and by the create form's Challenges section (competitions-admin.js), so the
// two cannot drift. It goes over the PER-TASK route
// (`POST /api/admin/tasks/:id/competitions`), never the best-effort bulk
// endpoint: only the per-task route names the refused challenge (a Booth
// Event's fit refusal, a lock), which is what an organiser can act on.

import { csrfHeaders } from "../core/api.js";

/**
 * Bounded concurrency in which EVERY item is attempted and no rejection
 * escapes: a thrown fetch becomes a named failure line, so the counters are
 * final when the caller reads them (see assignPickedTasks for the history).
 */
export async function runBoundedCollect(items, width, fn, failures, nameOf) {
  let i = 0;
  const workers = Array.from({ length: Math.min(width, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      try { await fn(items[idx]); }
      catch (e) { failures.push(`${nameOf(items[idx])}: ${(e && e.message) || "the connection failed"}`); }
    }
  });
  await Promise.all(workers);
}

/**
 * Add `taskIds` to event `compId`. Returns `{added, already, refused, failures}`:
 * `refused` is the structured staff-compete seal refusal (render it with
 * showAssignmentRefusalModal), `failures` one "<title>: <reason>" line per
 * other refusal. Never throws.
 */
export async function addTasksToCompetition(compId, taskIds, nameOf) {
  const out = { added: 0, already: 0, refused: [], failures: [] };
  const label = typeof nameOf === "function" ? nameOf : (id => String(id));
  await runBoundedCollect(taskIds || [], 6, async (tid) => {
    const r = await fetch(`/api/admin/tasks/${encodeURIComponent(tid)}/competitions`, {
      method: "POST", headers: csrfHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ competitionIds: [compId] }),
    });
    const d = await r.json().catch(() => ({}));
    if (r.ok) { const n = Number(d.assigned) || 0; out.added += n; if (n === 0) out.already++; return; }
    if (d.code && Array.isArray(d.refused) && d.refused.length) out.refused.push(...d.refused);
    else out.failures.push(`${label(tid)}: ${d.error || r.status}`);
  }, out.failures, label);
  return out;
}
