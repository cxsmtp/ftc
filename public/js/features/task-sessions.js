// PER-SESSION QUESTION SETS (owner decision, 27 Nov 2026) — the workspace
// Questions section's per-row "Sessions" choice.
//
// "Each session can hold a different question set." A Competition's question is
// in every session unless it is narrowed to chosen ones; the server is the
// authority (routes/sessions.js, lib/session-tasks.js) and this module only
// draws its answers: the event's choices (GET …/task-sessions, read beside the
// question list in a workspace), a chip on each of the event's own questions,
// and the dialog that changes one question's sessions (PUT …/tasks/:id/sessions).
//
// Offered only where the server says it can be used (`offered`: a kind that runs
// sessions, with two or more) and to a role that may change an assignment
// (`challenges.assign`) who is not competing in the event; anyone else sees the
// chip as text. A session that has started keeps its questions: its box is shown
// ticked or not and cannot be changed, with the reason beside it, and the
// server refuses the same change (409 task_sessions_locked).
import { S } from "../core/state.js";
import { csrfHeaders } from "../core/api.js";
import { setSafeHtml } from "../core/trusted-types.js";
import { esc } from "../ui/format.js";
import { overlayDismiss } from "../ui/modal.js";
import { showToast } from "../ui/toast.js";
import { isQualifyingTask } from "../ui/task-search.js";
import { adminCan } from "../ui/nav.js"; // read inside functions only (the nav cycle)
import { renderAdminTasks } from "./challenges-admin.js"; // read inside functions only

/**
 * Read the open event's session choices into `S.adminTaskSessions`
 * ({compId, offered, timeslots, tasks}); null when there is no open event, the
 * kind runs no sessions or the read failed (the chips then draw nothing rather
 * than a guess).
 */
export async function loadTaskSessions(compId) {
  S.adminTaskSessions = null;
  if (!compId || !adminCan('events.view')) return null;
  const comp = (S.adminCompetitionsData || []).find(c => c.id === compId);
  if (comp && comp.policy && comp.policy.sessions && comp.policy.sessions !== 'many') return null;
  let body = null;
  try {
    const r = await fetch(`/api/admin/competitions/${encodeURIComponent(compId)}/task-sessions`);
    if (r.ok) body = await r.json();
  } catch (_) { body = null; }
  if (!body || body.ok !== true || compId !== S.adminSelectedCompetitionId) return null;
  S.adminTaskSessions = { compId, offered: !!body.offered, timeslots: Array.isArray(body.timeslots) ? body.timeslots : [], tasks: body.tasks || {} };
  return S.adminTaskSessions;
}

function _openEvent() {
  return (S.adminCompetitionsData || []).find(c => c.id === S.adminSelectedCompetitionId) || null;
}

/** The sessions a question is in, as names ("All sessions" when it is in every one). */
function _sessionsText(ts, taskId) {
  const ids = ts.tasks[taskId];
  if (!ids || !ids.length) return 'All sessions';
  return ts.timeslots.filter(s => ids.includes(s.id)).map(s => s.name).join(', ') || 'All sessions';
}

/**
 * The "Sessions" chip of one question row in the open event's workspace, or ''
 * where the choice does not apply: no open event, fewer than two sessions, a
 * question the event does not hold, or a Quick (qualifying) question (asked of
 * everyone, so in every session).
 */
export function taskSessionsCellHtml(t) {
  const ts = S.adminTaskSessions;
  if (!ts || !ts.offered || ts.compId !== S.adminSelectedCompetitionId) return '';
  if (!(t.competitions || []).some(c => c.id === ts.compId) || isQualifyingTask(t)) return '';
  const text = _sessionsText(ts, t.id);
  const narrowed = !!(ts.tasks[t.id] && ts.tasks[t.id].length);
  const comp = _openEvent();
  const may = adminCan('challenges.assign') && !(comp && comp.competing);
  const cls = `session-chip${narrowed ? ' is-narrowed' : ''}`;
  return may
    ? `<button type="button" class="${cls}" data-action="task-sessions" data-task-id="${esc(t.id)}" aria-label="Sessions: ${esc(text)} — choose the sessions “${esc(t.title)}” is in">${esc(text)}</button>`
    : `<span class="${cls}" title="Sessions: ${esc(text)}">${esc(text)}</span>`;
}

let _openSeq = 0;
/** The dialog: one question's sessions. */
export async function openTaskSessions(taskId) {
  const seq = ++_openSeq;
  const compId = S.adminSelectedCompetitionId;
  const task = (S.adminTasksData || []).find(t => t.id === taskId);
  if (!compId || !task) { showToast('That question is no longer in the list. Refresh and try again.', 'error'); return; }
  // Read fresh: a session may have started, or someone may have changed the choice.
  const ts = await loadTaskSessions(compId);
  if (seq !== _openSeq) return;
  if (!ts || !ts.offered) { showToast('Could not load this event’s sessions. Please try again.', 'error'); return; }
  const current = ts.tasks[taskId] && ts.tasks[taskId].length ? [...ts.tasks[taskId]] : null;
  const started = (s) => s.status !== 'upcoming';
  const inNow = (id) => current === null || current.includes(id);

  document.querySelectorAll('#task-sessions-overlay').forEach(o => o.remove());
  const overlay = document.createElement('div');
  overlay.id = 'task-sessions-overlay';
  overlay.className = 'picker-overlay';
  const rows = ts.timeslots.map(s => {
    const locked = started(s);
    const why = locked ? `${s.status === 'live' ? 'Running' : 'Ended'}: its questions are fixed` : '';
    return `<label class="picker-row${locked ? ' is-disabled' : ''}">
      <input type="checkbox" class="picker-row-check tsq-box" value="${esc(s.id)}" ${inNow(s.id) ? 'checked' : ''} ${locked ? 'disabled' : ''}/>
      <span class="picker-row-body"><span class="tsq-name">${esc(s.name)}</span>${why ? ` <small class="tsq-why">${esc(why)}</small>` : ''}</span>
    </label>`;
  }).join('');
  setSafeHtml(overlay, `<div class="picker-modal picker-modal-flow tsq-modal" role="dialog" aria-modal="true" aria-labelledby="tsq-title" aria-describedby="tsq-help">
    <div class="picker-modal-head"><h3 id="tsq-title">Sessions for “${esc(task.title)}”</h3></div>
    <p class="picker-note" id="tsq-help">Each participant sees, answers and finishes only the questions of their own session. Tick the sessions this question is in; ticking them all puts it in every session, as a question is by default. A session's questions are fixed once it starts.</p>
    <fieldset class="tsq-list"><legend class="sr-only">Sessions this question is in</legend>
      <div class="picker-rows" id="tsq-rows">${rows}</div>
    </fieldset>
    <p class="picker-note tsq-error" id="tsq-error" role="alert" hidden></p>
    <div class="picker-modal-foot">
      <button class="btn secondary" data-action="overlay-close" data-overlay-id="task-sessions-overlay">Cancel</button>
      <button class="btn" id="tsq-save">Save</button>
    </div>
  </div>`);
  document.body.appendChild(overlay);
  overlayDismiss(overlay, () => overlay.remove());
  const err = overlay.querySelector('#tsq-error');
  const say = (msg) => { err.textContent = msg || ''; err.hidden = !msg; };
  const save = overlay.querySelector('#tsq-save');
  overlay.querySelector('#tsq-rows').addEventListener('change', () => {
    const any = overlay.querySelectorAll('.tsq-box:checked').length > 0;
    save.disabled = !any;
    say(any ? '' : 'A question must be in at least one session. To take it out of the event, use Remove from Event.');
  });
  save.addEventListener('click', async () => {
    const picked = [...overlay.querySelectorAll('.tsq-box:checked')].map(b => b.value);
    if (!picked.length) return;
    const all = ts.timeslots.map(s => s.id);
    const timeslotIds = picked.length === all.length ? null : picked;
    save.disabled = true;
    let r = null, d = {};
    try {
      r = await fetch(`/api/admin/competitions/${encodeURIComponent(compId)}/tasks/${encodeURIComponent(taskId)}/sessions`, {
        method: 'PUT', headers: csrfHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ timeslotIds, expectedTimeslotIds: current }),
      });
      d = await r.json().catch(() => ({}));
    } catch (_) { r = null; }
    if (!r || !r.ok) {
      save.disabled = false;
      say((d && d.error) || 'Nothing was saved: the server could not be reached. Try again.');
      return;
    }
    overlay.remove();
    await loadTaskSessions(compId);
    renderAdminTasks();
    if (d.changed) showToast(timeslotIds === null ? `“${task.title}” is now in every session.` : `“${task.title}” is now in ${picked.length} of ${all.length} sessions.`, 'success');
  });
  // The first box that can change takes focus (after the opener is captured).
  (overlay.querySelector('.tsq-box:not([disabled])') || save).focus();
}
