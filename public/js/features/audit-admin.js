"use strict";

// THE AUDIT PANE (admin-audit-tab) — one newest-first list over every recorded
// act, read from GET /api/admin/audit (routes/audit.js).
//
// What it holds: a filter bar (record-type chips, actor, event, date range,
// outcome, search), a table that the shared table-cards observer turns into one
// card per row on phones, a details dialog per row, the Raw logs pager (numbered
// pages), CSV export of the page shown, and a "Raw logs" door to the existing
// Logs pane (global admins only — the server refuses the logs to event admins).
//
// Rules it keeps (CLAUDE.md *SPA conventions*):
//   - the search and filter inputs are SIBLINGS of the tbody the loader
//     re-renders, never children;
//   - every load claims `S._auditFetchSeq` and drops a stale answer;
//   - a failed first page renders `renderLoadFailure` into the table with a
//     Try again button (the pane has no poll); a failed later page keeps the
//     rows already shown and says so;
//   - the event list is re-read on every pane entry (nothing would invalidate it);
//   - the CSV writes exactly the rows on screen, through ui/csv.js.

import { S } from "../core/state.js";
import { setSafeHtml } from "../core/trusted-types.js";
import { fetchJsonList } from "../core/api.js";
import { renderLoadFailure, colspanFor, paginationHtml, segmentParams, segmentExact, segmentAbsorb, segmentStepTarget, segmentLastTarget, segmentGoTo, segmentBarOptions, syncPageJump } from "../ui/list-controls.js";
import { esc, fmtDt } from "../ui/format.js";
import { showToast } from "../ui/toast.js";
import { downloadCsv } from "../ui/csv.js";
import { overlayDismiss } from "../ui/modal.js";
import { registerHelpTips } from "../ui/help-tips.js";
import { adminTab, adminCan } from "../ui/nav.js";
import { clearColumnFilters } from "../ui/table-columns.js"; // openAuditNarrowed: no heading filter may hide the narrowed rows
import { compareCompsForPicker } from "./competitions-admin.js"; // the shared order of every admin event picker

export const AUDIT_TYPE_LABELS = Object.freeze({
  event: "Event",
  session: "Session",
  person: "Person",
  setting: "Setting",
  challenge_version: "Challenge version",
  submission: "Submission",
  hint: "Hint",
  log_event: "Log event",
});
const OUTCOME_LABELS = Object.freeze({ success: "Success", failure: "Failure", unknown: "Unknown", correct: "Correct", wrong: "Wrong" });

// THE ACTIVITY WORDING. Every `event_type` the server records (the record*Event /
// recordOrphanedAuditEvent / createTaskVersion calls, the task-event map in
// lib/audit.js, the CxOne removal emits, the badge downloads, and the audit
// route's own submission / hint types) in plain words. The same key can come
// from several record types (an event, a session and a person are each
// "Created"); the Type column says which. The raw key stays in the details
// dialog and the CSV. A key missing here reads as itself, underscores spaced and
// the first letter capitalised (auditActivityLabel), so a new type is never
// blank — and tests/audit-activity-labels.spec.js fails until it gets wording.
export const AUDIT_ACTIVITY_LABELS = Object.freeze({
  account_reaped: "Unconfirmed account removed",
  active_competition_changed: "Switched event",
  added_to_competition: "Added to event",
  admin_logout: "Admin signed out",
  admin_view_toggled: "Switched between admin and participant view",
  approved: "Account approved",
  attachment_added: "Attachment added",
  attachment_removed: "Attachment removed",
  attachment_renamed: "Attachment renamed",
  attachment_staged: "Attachment uploaded (not saved yet)",
  attachment_staging_discarded: "Unsaved attachment discarded",
  attachment_staging_renamed: "Unsaved attachment renamed",
  attempt_grant: "Extra attempts granted",
  auto_ended: "Ended automatically",
  auto_locked: "Locked after wrong sign-in codes",
  auto_started: "Started on schedule",
  auto_unlocked: "Sign-in lock lifted",
  badge_certificate_downloaded: "Certificate PDF downloaded",
  badge_image_downloaded: "Certificate image downloaded",
  badge_minted: "Certificate issued",
  badge_revoked: "Certificate revoked",
  badge_reissued: "Certificate issued again",
  badge_shared: "Certificate shared",
  batch_imported: "Import finished",
  batch_sent: "Invitations sent",
  blocked: "Blocked",
  builtin_restored: "Built-in template restored",
  certificate_config_changed: "Certificate design changed",
  certificate_emailed: "Certificate emailed",
  cleared: "Cleared",
  competition_session_cleared: "Session choice cleared",
  create: "Challenge created",
  created: "Created",
  credential_lookup_failed: "Certificate check failed",
  credential_resolved: "Certificate checked",
  credential_verified: "Certificate verified",
  cxone_binding_cleared: "Checkmarx One link cleared",
  cxone_config_changed: "Checkmarx One settings changed",
  cxone_provision_abandoned: "Checkmarx One set-up abandoned",
  cxone_provisioned: "Checkmarx One account set up",
  cxone_realm_account_withdrawn: "Checkmarx One account removed",
  cxone_realm_withdrawal_dismissed: "Checkmarx One removal dismissed",
  cxone_realm_withdrawal_given_up: "Checkmarx One removal given up",
  cxone_realm_withdrawal_held: "Checkmarx One removal on hold",
  cxone_realm_withdrawal_needs_attention: "Checkmarx One removal needs attention",
  cxone_realm_withdrawal_past_retention: "Checkmarx One removal past retention",
  cxone_realm_withdrawal_retried: "Checkmarx One removal retried",
  cxone_realm_withdrawal_transferred: "Checkmarx One account passed to another participant",
  cxone_realm_withdrawals_past_retention: "Checkmarx One removals past retention",
  data_exported: "Data exported",
  deleted: "Deleted",
  denied: "Account denied",
  edited: "Edited",
  effective_end_shifted: "End time moved",
  email_change_cancelled: "Email change cancelled",
  email_change_confirmed: "Email change confirmed",
  email_change_conflict: "Email change refused (address in use)",
  email_change_expired: "Email change expired",
  email_change_requested: "Email change requested",
  email_proof_burned: "Sign-up code cancelled after wrong guesses",
  email_proof_redeemed: "New address confirmed",
  email_proof_event_dropped: "Sign-up code no longer joins an event",
  email_proof_refused: "Sign-up code refused",
  email_proof_requested: "Sign-up code requested",
  email_resubscribed: "Resubscribed to emails",
  email_sent: "Email sent",
  email_suppressed: "Email not sent",
  email_unsubscribed: "Unsubscribed from emails",
  ended_manually: "Ended by an organiser",
  ended_popup_dismissed: "Event-ended notice dismissed",
  event_admin_granted: "Made organiser",
  event_admin_revoked: "Organiser role removed",
  events_purged: "Old history removed",
  feedback_purged: "Feedback removed (retention)",
  feedback_removed: "Feedback removed",
  feedback_submitted: "Feedback given",
  first_joined: "Entered for the first time",
  group_added: "Added to group",
  group_bound: "Group linked to event",
  group_created: "Group created",
  group_deleted: "Group deleted",
  group_removed: "Removed from group",
  group_renamed: "Group renamed",
  group_unbound: "Group unlinked from event",
  hint_revealed: "Hint revealed",
  history_seeded: "Test history created",
  impersonation_ended: "Viewing as participant ended",
  impersonation_started: "Viewing as participant started",
  import: "Challenge imported",
  imported: "Imported",
  invitation_competition_added: "Invitation added to event",
  ip_ban_alert_dismissed: "Blocked-address alert dismissed",
  ip_ban_alert_raised: "Blocked-address alert raised",
  joined_competition_session: "Joined a session",
  late_entry_closed: "Late entries closed",
  lock: "Challenge locked",
  locked: "Locked",
  login_code_redeemed: "Signed in with a code",
  login_code_event_dropped: "Sign-in code no longer joins an event",
  login_code_refused: "Sign-in code refused",
  login_code_requested: "Sign-in code requested",
  login_code_revealed: "Sign-in code shown at the desk",
  login_failed: "Sign-in failed",
  login_method_changed: "Sign-in method changed",
  login_success: "Signed in",
  logout_manual: "Signed out",
  look_changed: "Look changed",
  password_changed: "Password changed",
  password_set: "Password set",
  team_member_added: "Team member added",
  team_member_removed: "Team member removed",
  team_targets_changed: "Lead targets changed",
  team_report_sent: "Team report sent",
  team_report_given_up: "Team report given up",
  lead_contacted: "Lead marked contacted",
  membership_promoted: "Membership made direct",
  profile_updated_self: "Updated own profile",
  protected: "Template protected",
  publish: "Challenge published",
  published: "Published",
  purged: "Removed for good",
  reminder_cleared: "Reminder cancelled",
  reminder_email_sent: "Reminder email sent",
  reminder_requested: "Reminder scheduled",
  reminder_skipped: "Reminder not sent (already started)",
  removed_from_competition: "Removed from event",
  reset: "Reset to default",
  restore: "Challenge restored",
  restored: "Restored",
  resubscribed: "Resubscribed",
  revived: "Reopened",
  role_changed: "Role changed",
  role_created: "Role created",
  role_deleted: "Role deleted",
  role_updated: "Role updated",
  rotated: "Replaced with a new one",
  rotation_suppressed: "Replacement skipped",
  scanner_blocked: "Address blocked for scanning",
  scores_recalculated: "Scores recalculated",
  sealed_answer_revealed: "Sealed answer revealed",
  sealed_reveal: "Sealed answer revealed",
  self_enroll_regenerated: "Join link replaced",
  self_enroll_revealed: "Join link shown",
  self_enrolled: "Joined through the join link",
  self_registered: "Signed up",
  self_verified: "Email confirmed",
  session_chosen: "Session chosen",
  sessions_invalidated: "Other sessions signed out",
  spawned: "Event created from template",
  submission_correct: "Correct answer",
  submission_wrong: "Wrong answer",
  superadmin_login_success: "Break-glass sign-in",
  tag_added: "Tag added",
  tag_removed: "Tag removed",
  task_added: "Challenge added",
  task_removed: "Challenge removed",
  test_email_sent: "Test email sent",
  timeslot_added: "Session added",
  timeslot_cleared: "Session choice cleared",
  timeslot_deleted: "Session deleted",
  trusted_networks_applied: "Trusted addresses saved again",
  trusted_networks_changed: "Trusted addresses changed",
  unblocked: "Unblocked",
  unlock: "Challenge unlocked",
  unlocked: "Unlocked",
  unprotected: "Template protection removed",
  unsubscribed: "Unsubscribed",
  update: "Challenge edited",
  updated: "Updated",
  user_added: "Person added",
  user_removed: "Person removed",
  users_seeded: "Test users created",
  verification_resent: "Confirmation email sent again",
  verified: "Email confirmed",
  verify_code_expired: "Confirmation link expired",
  version_created: "Version saved",
  visibility: "Challenge shown or hidden",
  visibility_toggled: "Shown or hidden",
});

/** The plain wording for an event_type; an unknown key reads as itself with its
 *  underscores spaced and the first letter capitalised. */
export function auditActivityLabel(key, details) {
  const k = String(key == null ? "" : key);
  // A certificate PDF fetched through the congratulations email's link
  // (`via:"email_link"`): mail scanners open every link in a mail, signed out, as
  // its holder's own click would, so the row says so unless the holder's own
  // signed-in session made it (sweep #402; History words it the same way).
  if (k === "badge_certificate_downloaded" && details && details.via === "email_link") {
    return details.by_owner === true
      ? "Certificate PDF downloaded from the email link"
      : "Certificate PDF downloaded from the email link (may be a mail scanner)";
  }
  if (Object.prototype.hasOwnProperty.call(AUDIT_ACTIVITY_LABELS, k)) return AUDIT_ACTIVITY_LABELS[k];
  const spaced = k.replace(/_+/g, " ").trim();
  return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : "";
}

/** The event_type keys whose wording (or spaced key) contains the typed search,
 *  so a search for "signed in" also finds `login_success`. At most 50 (the
 *  route's list cap); the raw-key search runs on the server either way. */
export function auditActivityKeysMatching(q) {
  const t = String(q || "").trim().toLowerCase();
  if (t.length < 2) return [];
  const out = [];
  for (const [k, label] of Object.entries(AUDIT_ACTIVITY_LABELS)) {
    if (label.toLowerCase().includes(t) || k.replace(/_+/g, " ").includes(t)) out.push(k);
    if (out.length >= 50) break;
  }
  return out;
}
const AUDIT_PAGE_SIZES = [50, 100, 200, 500];   // Raw logs' sizes

export const AUDIT_HELP_TIPS = {
  "audit.types": "Pick one or more kinds of record to show. With none picked, every kind you may see is listed.",
  "audit.filters": {
    default: "Narrow the list by who acted, which event, a date range or the outcome. The search matches the activity (its wording or its technical name), the actor and what it was about.",
    event_admin: "Narrow the list by who acted, which of your events, a date range or the outcome. The search matches the activity's wording or technical name. You see records from your own events only.",
  },
  "audit.raw": "The raw audit and request log files, including records written before this page existed. Global admins only.",
  "audit.paging": "Records are listed newest first, one page at a time, as in Raw logs. Last and Go to page need an exact count, so narrow the filters on a long history. Export this page (CSV) saves the page shown.",
};

// Per-tab pane state (no persistence: a filter is a question, not a preference).
// `queryKey` is the filter query the rows on screen were loaded with: a later
// page continues only that list (loadAdminAudit). `searchedTo` is how far back
// the last read searched when the server bounded its walk (routes/audit.js
// AUDIT_SCAN_BUDGET), else null; `cutAt` the first page whose walk was cut.
// The pager's state is ui/list-controls.js's segment pager (`newSegmentPager`'s
// fields), shared with Raw logs.
const _st = { types: new Set(), rows: [], hasMore: false, total: null, totalExact: false, searchTimer: null, queryKey: null, searchedTo: null, readable: null,
  page: 1, pageSize: AUDIT_PAGE_SIZES[0], anchor: null, segments: [], nextCursor: null, cutAt: null, offsetMax: 10000 };

function _isEventAdmin() { return !!S.isEventAdmin; }

/** Raw logs (the Logs pane) is for global admins holding `audit.raw_logs`. */
function _rawLogsOffered() { return !_isEventAdmin() && adminCan("audit.raw_logs"); }

function _syncRoleControls() {
  const raw = document.getElementById("audit-view-raw");
  // RBAC — Raw logs needs `audit.raw_logs` (a custom role may lack it). Its "?"
  // goes with it: a tip beside nothing would explain a door this role lacks.
  const off = !_rawLogsOffered();
  if (raw) raw.hidden = off;
  const tip = document.getElementById("audit-view-raw-tip");
  if (tip) tip.hidden = off;
  const setting = document.querySelector('#audit-type-filters [data-type="setting"]');
  if (setting) {
    setting.hidden = _isEventAdmin();
    if (_isEventAdmin()) { _st.types.delete("setting"); setting.setAttribute("aria-pressed", "false"); setting.classList.remove("active"); }
  }
  _syncTypeChips();
}

// Which kinds of record this reader may see is the SERVER's answer
// (`readable_types`: each kind follows the permission that guards the same rows
// elsewhere — routes/audit.js), never re-derived here. A chip for a kind the
// reader may not see is hidden and unpicked. Until the first answer the chips
// stand as rendered (the event-admin rule above covers the one known up front).
function _syncTypeChips() {
  if (!Array.isArray(_st.readable)) return;
  document.querySelectorAll("#audit-type-filters [data-type]").forEach(b => {
    const ok = _st.readable.includes(b.dataset.type);
    b.hidden = !ok;
    if (!ok) { _st.types.delete(b.dataset.type); b.classList.remove("active"); b.setAttribute("aria-pressed", "false"); }
  });
}

async function _loadEventOptions() {
  const sel = document.getElementById("audit-event");
  if (!sel) return;
  const keep = sel.value;
  // RBAC — the event list is an `events.view` read: a role without it keeps
  // "All events" and sends no request the gate refuses.
  if (!adminCan("events.view")) return;
  const comps = await fetchJsonList("/api/admin/competitions");
  if (!comps) return;   // the filter stays usable with "All events"; the list itself reports failures
  // The shared order of every admin event picker: live first, then upcoming by
  // soonest start, then ended by latest start.
  const opts = comps
    .filter(c => c && c.id)
    .sort(compareCompsForPicker)
    .map(c => `<option value="${esc(c.id)}">${esc(c.name || c.id)}</option>`)
    .join("");
  setSafeHtml(sel, `<option value="">All events</option>${opts}`);
  if (keep && comps.some(c => c.id === keep)) sel.value = keep;
}

function _dateParam(id, endOfDay) {
  const v = (document.getElementById(id)?.value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  // The date inputs are local calendar days; send the instant the day starts
  // (or ends) in this browser's zone.
  const [y, m, d] = v.split("-").map(Number);
  const dt = endOfDay ? new Date(y, m - 1, d, 23, 59, 59, 999) : new Date(y, m - 1, d, 0, 0, 0, 0);
  return Number.isNaN(dt.getTime()) ? null : dt.toISOString();
}

function _queryParams() {
  const p = new URLSearchParams();
  p.set("limit", String(_st.pageSize));
  if (_st.types.size) p.set("types", [..._st.types].join(","));
  const actor = (document.getElementById("audit-actor")?.value || "").trim();
  if (actor) p.set("actor", actor);
  const comp = document.getElementById("audit-event")?.value || "";
  if (comp) p.set("competitionId", comp);
  const outcome = document.getElementById("audit-outcome")?.value || "";
  if (outcome) p.set("outcome", outcome);
  const from = _dateParam("audit-from", false);
  if (from) p.set("from", from);
  const to = _dateParam("audit-to", true);
  if (to) p.set("to", to);
  const q = (document.getElementById("audit-search")?.value || "").trim();
  if (q) {
    p.set("q", q);
    // The Activity column shows plain wording, so the search matches it too: the
    // keys whose wording contains the text ride along and the server ORs them in.
    const keys = auditActivityKeysMatching(q);
    if (keys.length) p.set("q_event_types", keys.join(","));
  }
  return p;
}

function _subjectText(r) {
  const s = r.subject || {};
  return s.label || s.id || "";
}

/** The record's instant as ISO 8601 ("" when unreadable): the When column's
 *  sort and date-filter value, never its locale text ("Nov 5" sorts before
 *  "Oct 31" by letters). */
function _isoAt(at) {
  const t = Date.parse(at);
  return Number.isFinite(t) ? new Date(t).toISOString() : "";
}

function _rowHtml(r, idx) {
  const type = AUDIT_TYPE_LABELS[r.type] || r.type;
  const outcome = OUTCOME_LABELS[r.outcome] || r.outcome || "";
  const ocls = r.outcome === "failure" || r.outcome === "wrong" ? "audit-outcome audit-outcome-bad" : "audit-outcome";
  const subj = _subjectText(r);
  return `<tr>
    <td class="audit-when" data-sort-value="${esc(_isoAt(r.at))}">${esc(fmtDt(r.at, "full"))}</td>
    <td><span class="badge audit-type-badge" data-type="${esc(r.type)}">${esc(type)}</span></td>
    <td class="audit-activity" data-event-type="${esc(r.event_type || "")}">${esc(auditActivityLabel(r.event_type, r.details))}</td>
    <td class="audit-actor">${esc(r.actor || "—")}</td>
    <td class="audit-subject">${esc(subj || "—")}</td>
    <td>${esc(r.competition_name || "—")}</td>
    <td><span class="${ocls}">${esc(outcome)}</span></td>
    <td><button type="button" class="btn sm secondary" data-action="audit-row-details" data-idx="${idx}" aria-label="Details — show this ${esc(type.toLowerCase())} record in full">Details</button></td>
  </tr>`;
}

function _paintCount() {
  const el = document.getElementById("audit-count");
  if (!el) return;
  const n = _st.rows.length;
  const plural = (k) => (k === 1 ? "record" : "records");
  // Rows are numbered from the top while every page before this one was full:
  // a page past a walk the server cut (cutAt) starts wherever that walk stopped.
  const first = n && (_st.cutAt == null || _st.page <= _st.cutAt) ? (_st.page - 1) * _st.pageSize + 1 : null;
  const shown = first == null ? String(n) : n === 1 ? String(first) : `${first}–${first + n - 1}`;
  const upTo = first == null ? n : first + n - 1;
  let t;
  if (_st.totalExact && _st.total != null) t = `Showing ${shown} of ${_st.total} ${plural(_st.total)}`;
  // A count the server stopped at its ceiling, or over the rows a bounded walk
  // searched, is a floor (routes/audit.js AUDIT_COUNT_MAX, AUDIT_SCAN_BUDGET),
  // quoted only while it says more than the rows shown do, and never past a cut
  // walk (those pages are not numbered from the top, so no floor can be placed).
  else if (first != null && _st.total != null && _st.total > 0 && _st.total >= upTo) t = `Showing ${shown} of ${_st.total}+ records`;
  else t = `Showing ${n} ${plural(n)}${_st.hasMore && !_st.searchedTo ? " (more available)" : ""}`;
  // A walk the server bounded says how far back it searched; Next goes on.
  if (_st.searchedTo) t += ` · searched back to ${fmtDt(_st.searchedTo, "long")}`;
  if (el.textContent !== t) el.textContent = t;
}

function _paint() {
  const body = document.getElementById("admin-audit-body");
  if (!body) return;
  if (!_st.rows.length) {
    const filtered = _st.types.size || [...document.querySelectorAll("#admin-audit-tab .audit-filterbar input, #admin-audit-tab .audit-filterbar select")].some(el => (el.value || "").trim());
    // A bounded walk that found nothing has not searched everything: say how far
    // it got and how to go further, never "nothing matches".
    const msg = _st.searchedTo
      ? `No matching records back to ${esc(fmtDt(_st.searchedTo, "long"))}. Next searches further back, or set From and To.`
      : filtered ? "No audit records match these filters. Clear a filter to see more." : "Nothing has been recorded yet.";
    setSafeHtml(body, `<tr><td colspan="${colspanFor("admin-audit-body")}" class="table-empty-row">${msg}</td></tr>`);
  } else {
    setSafeHtml(body, _st.rows.map((r, i) => _rowHtml(r, i)).join(""));
  }
  const exp = document.getElementById("audit-export");
  if (exp) exp.disabled = !_st.rows.length;
  _paintPager();
  _paintCount();
}

// THE PAGER: ui/list-controls.js's segment pager (one definition, shared with
// Raw logs' Audit log), drawn with paginationHtml and the page box in index.html.
const _JUMP = { jump: "audit-page-jump", input: "audit-page-input", note: "audit-page-jump-note" };
function _paintPager() {
  const bar = document.getElementById("audit-pagination-bar");
  if (!bar) return;
  const o = segmentBarOptions(_st);
  setSafeHtml(bar, paginationHtml("audit", {
    page: o.page, totalPages: o.totalPages, pagesLabel: o.pagesLabel, totalLabel: o.totalLabel,
    hasPrev: o.hasPrev, hasNext: o.hasNext, lastEnabled: o.lastEnabled,
    pageSize: _st.pageSize, sizes: AUDIT_PAGE_SIZES, jump10: true,
  }));
  _syncPageJump(true);
}

// The page box follows the newest answer; it never writes the box's value.
function _syncPageJump(loaded) {
  syncPageJump(_JUMP, loaded && segmentExact(_st), loaded ? "Narrow the filters to get an exact count." : "");
}

/** Load page `n` of the list the filter bar shows (anything but a page number past 1: the first page). */
export async function loadAdminAudit(n) {
  const p = _queryParams();
  const key = p.toString();
  let pageN = Number.isInteger(n) && n > 1 ? n : 1;
  // A later page continues THE LIST ON SCREEN, whose positions belong to the
  // filters it was loaded with. When the filter bar has changed since (an Actor
  // or date whose `change` fired on the way to the button, a search still in
  // its debounce), the press loads the first page of the filters shown instead:
  // never the old list's page under the new filters.
  if (pageN > 1 && key !== _st.queryKey) pageN = 1;
  const at = segmentParams(_st, pageN);
  if (!at) return;
  // A first-page load reads every input as it stands, so a pending search
  // debounce has nothing left to add.
  if (pageN === 1) clearTimeout(_st.searchTimer);
  for (const [k, v] of Object.entries(at)) p.set(k, v);
  const mySeq = ++S._auditFetchSeq;
  const bar = document.getElementById("audit-pagination-bar");
  if (pageN > 1 && bar) bar.querySelectorAll("button, select").forEach((c) => { c.disabled = true; });
  let d = null;
  let refusal = null;
  let refusedType = null;
  // The route's limiter (429) refuses for now, not for good: its sentence is
  // shown with Try again, which a refusal of the filters themselves never gets.
  let transient = false;
  try {
    const r = await fetch(`/api/admin/audit?${p.toString()}`);
    const body = await r.json().catch(() => null);
    if (r.ok && body && Array.isArray(body.rows)) d = body;
    else if (body && typeof body.error === "string" && r.status >= 400 && r.status < 500) {
      refusal = body.error; transient = r.status === 429;
      if (body.code === "audit_type_forbidden" && typeof body.type === "string") refusedType = body.type;
    }
  } catch (_) { d = null; }
  if (mySeq !== S._auditFetchSeq) return;
  // A picked kind the reader may no longer see (its role changed since the page
  // loaded): drop that chip and load what the reader may see.
  if (!d && refusedType && _st.types.has(refusedType)) {
    if (Array.isArray(_st.readable)) _st.readable = _st.readable.filter(t => t !== refusedType);
    else _st.readable = Object.keys(AUDIT_TYPE_LABELS).filter(t => t !== refusedType);
    _syncTypeChips();
    loadAdminAudit(1);
    return;
  }
  if (!d) {
    if (pageN > 1) {
      _paintPager();   // the bar as it was, for the page still shown
      showToast(refusal || "Could not load that page of audit records. The rows already shown are unchanged.", "error");
      return;
    }
    Object.assign(_st, { rows: [], page: 1, segments: [], anchor: null, nextCursor: null, hasMore: false, total: null, totalExact: false, queryKey: null, searchedTo: null, cutAt: null });
    renderLoadFailure("admin-audit-body", {
      colspan: colspanFor("admin-audit-body"), noun: "audit records",
      retryAction: refusal && !transient ? null : "audit-retry",
      message: refusal ? `Could not load audit records: ${esc(refusal)}` : null,
    });
    // The pager must stop describing a table that failed to load.
    if (bar) setSafeHtml(bar, "");
    _syncPageJump(false);
    const exp = document.getElementById("audit-export");
    if (exp) exp.disabled = true;
    const c = document.getElementById("audit-count");
    if (c) c.textContent = "";
    return;
  }
  if (Array.isArray(d.readable_types)) { _st.readable = d.readable_types.slice(); _syncTypeChips(); }
  _st.rows = d.rows;
  segmentAbsorb(_st, pageN, { total: d.total, totalExact: d.total_exact, anchor: d.anchor, nextCursor: d.next_cursor,
    hasMore: d.has_more, searchedTo: d.searched_to, offsetMax: d.offset_max });
  if (pageN === 1) _st.queryKey = key;
  _paint();
}

/** Prev, Next, -10 and +10. Next reads below this page (a cursor: cheap at any depth). */
export function auditPageStep(delta) {
  const to = segmentStepTarget(_st, delta);
  if (to != null) loadAdminAudit(to);
}

/** Last: the counted last page; offered only with an exact count. */
export function auditPageLast() {
  const to = segmentLastTarget(_st);
  if (to != null) loadAdminAudit(to);
}

export function auditPageSize(el) {
  const n = parseInt(el && el.value, 10);
  if (!AUDIT_PAGE_SIZES.includes(n) || n === _st.pageSize) return;
  _st.pageSize = n;
  loadAdminAudit(1);
}

/**
 * Go to page: Raw logs' rules (settings-admin.js _logsGoToPage). An EMPTY box
 * does nothing, because Go blurs the box first, whose `change` already jumped;
 * the number is parsed strictly; an over-range page is clamped and said.
 */
export function auditGoToPage() {
  const input = document.getElementById("audit-page-input");
  const note = document.getElementById("audit-page-jump-note");
  if (!input) return;
  const r = segmentGoTo(_st, input.value);
  if (note) note.textContent = r.note;
  if (r.clear) input.value = "";
  if (r.to != null) loadAdminAudit(r.to);
}

/** Pane entry (registered as the admin-audit-tab loader in core/main.js). */
export function openAdminAudit() {
  _syncRoleControls();
  const view = document.getElementById("audit-view-trail");
  if (view) { view.classList.add("active"); view.setAttribute("aria-pressed", "true"); }
  _loadEventOptions();
  loadAdminAudit(1);
}

export function auditToggleType(el) {
  const t = el && el.dataset && el.dataset.type;
  if (!t || !AUDIT_TYPE_LABELS[t]) return;
  if (_st.types.has(t)) _st.types.delete(t); else _st.types.add(t);
  const on = _st.types.has(t);
  el.classList.toggle("active", on);
  el.setAttribute("aria-pressed", on ? "true" : "false");
  loadAdminAudit(1);
}

export function auditFiltersChanged() { loadAdminAudit(1); }

export function auditSearchInput(el) {
  const clear = document.getElementById("audit-search-clear");
  if (clear) clear.classList.toggle("hidden", !(el && el.value));
  clearTimeout(_st.searchTimer);
  _st.searchTimer = setTimeout(() => loadAdminAudit(1), 300);
}

export function auditSearchClear() {
  const el = document.getElementById("audit-search");
  if (el) el.value = "";
  const clear = document.getElementById("audit-search-clear");
  if (clear) clear.classList.add("hidden");
  clearTimeout(_st.searchTimer);
  loadAdminAudit(1);
}

export function auditClearFilters() {
  _st.types.clear();
  document.querySelectorAll("#audit-type-filters [data-type]").forEach(b => { b.classList.remove("active"); b.setAttribute("aria-pressed", "false"); });
  for (const id of ["audit-actor", "audit-event", "audit-outcome", "audit-from", "audit-to", "audit-search"]) {
    const el = document.getElementById(id);
    if (el) el.value = "";
  }
  const clear = document.getElementById("audit-search-clear");
  if (clear) clear.classList.add("hidden");
  loadAdminAudit(1);
}


/** Open the Audit page narrowed to one search (Settings → CxOne API audit):
 *  every other filter cleared, the text in the search box, so the trail lists
 *  the records whose activity wording matches it (the search sends the matching
 *  activity keys too). The page's own loader reads the box. */
export function openAuditNarrowed(q) {
  _st.types.clear();
  document.querySelectorAll("#audit-type-filters [data-type]").forEach(b => { b.classList.remove("active"); b.setAttribute("aria-pressed", "false"); });
  for (const id of ["audit-actor", "audit-event", "audit-outcome", "audit-from", "audit-to"]) {
    const el = document.getElementById(id);
    if (el) el.value = "";
  }
  const box = document.getElementById("audit-search");
  if (box) box.value = String(q || "");
  const clear = document.getElementById("audit-search-clear");
  if (clear) clear.classList.toggle("hidden", !(box && box.value));
  clearColumnFilters("audit");
  const item = _auditNavItem();
  if (item) adminTab(item, "admin-audit-tab");
}

// THE AUDIT PAGE'S TWO VIEWS. The trail is this pane; Raw logs is the Logs pane
// (features/settings-admin.js: the log files, paged, page 1 refreshing live and
// deeper pages anchored), which carries the same view switch. Logs has no
// sidebar item of its own, so either view keeps the Audit item current (and the
// phone section bar saying "Audit"). Pressing the view already on screen does
// nothing: re-entering Raw logs would drop the reader back to page 1. The Audit
// item always opens on the trail, never on the view used last (operator ruling,
// 14 Nov 2026), so nothing remembers the view.
function _auditNavItem() { return document.querySelector('.admin-nav-item[data-tab-id="admin-audit-tab"]'); }
function _paneShown(id) { return document.getElementById(id)?.style.display === "block"; }

export function auditShowRaw() {
  if (!_rawLogsOffered() || _paneShown("admin-logs-tab")) return;
  adminTab(_auditNavItem(), "admin-logs-tab");
}

export function auditShowTrail() {
  if (_paneShown("admin-audit-tab")) return;
  adminTab(_auditNavItem(), "admin-audit-tab");
}

/** The view switch (`audit-view`, on both panes). */
export function auditSetView(view) {
  if (view === "raw") auditShowRaw();
  else if (view === "trail") auditShowTrail();
}

function _detailRows(r) {
  const lines = [
    ["When", fmtDt(r.at, "full")],
    ["Type", AUDIT_TYPE_LABELS[r.type] || r.type],
    ["Activity", auditActivityLabel(r.event_type, r.details)],
    ["Activity key", r.event_type || ""],
    ["Actor", r.actor || "—"],
    ["Subject", `${(r.subject && r.subject.kind) || ""}${_subjectText(r) ? ` · ${_subjectText(r)}` : ""}`],
    ["Event", r.competition_name || r.competition_id || "—"],
    ["Outcome", OUTCOME_LABELS[r.outcome] || r.outcome || ""],
    ["Record", r.id],
  ];
  return lines.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("");
}

export function auditShowDetails(el) {
  const idx = parseInt(el && el.dataset && el.dataset.idx, 10);
  const r = Number.isInteger(idx) ? _st.rows[idx] : null;
  if (!r) return;
  document.getElementById("audit-detail-overlay")?.remove();
  const ov = document.createElement("div");
  ov.id = "audit-detail-overlay";
  ov.className = "picker-overlay";
  // Stored details that are not JSON reach the page marked (lib/audit.js
  // parseStoredDetails): something was recorded, so never "no further details".
  const detailsJson = r.details == null ? "No further details were recorded."
    : r.details.details_unreadable === true ? "The details recorded for this entry could not be read."
    : JSON.stringify(r.details, null, 2);
  setSafeHtml(ov, `<div class="picker-modal audit-detail" role="dialog" aria-modal="true" aria-labelledby="audit-detail-title">
    <div class="picker-modal-head"><h3 id="audit-detail-title">Audit record</h3>
      <button type="button" class="link-btn" data-action="audit-detail-close">Close</button></div>
    <dl class="audit-detail-list">${_detailRows(r)}</dl>
    <h4 class="audit-detail-sub">Details</h4>
    <pre class="audit-detail-json">${esc(detailsJson)}</pre>
  </div>`);
  document.body.appendChild(ov);
  const close = () => { cleanup(); ov.remove(); };
  const cleanup = overlayDismiss(ov, close);
  ov._close = close;
  const btn = ov.querySelector('[data-action="audit-detail-close"]');
  if (btn) btn.focus();
}

export function auditCloseDetails() {
  const ov = document.getElementById("audit-detail-overlay");
  if (ov && typeof ov._close === "function") ov._close();
  else if (ov) ov.remove();
}

export function auditExportCsv() {
  if (!_st.rows.length) { showToast("There are no audit records on screen to export."); return; }
  const headers = ["When", "Type", "Activity", "Activity key", "Actor", "Subject", "Subject ID", "Event", "Event ID", "Session ID", "Outcome", "Record", "Details"];
  const rows = _st.rows.map(r => [
    r.at, AUDIT_TYPE_LABELS[r.type] || r.type, auditActivityLabel(r.event_type, r.details), r.event_type || "", r.actor || "",
    _subjectText(r), (r.subject && r.subject.id) || "", r.competition_name || "", r.competition_id || "",
    r.timeslot_id || "", OUTCOME_LABELS[r.outcome] || r.outcome || "", r.id,
    r.details == null ? "" : JSON.stringify(r.details),
  ]);
  const stamp = new Date().toISOString().slice(0, 10);
  downloadCsv(`audit-${stamp}.csv`, headers, rows);
}

/** Boot-time registration of this pane's help-tip strings. */
export function registerAuditHelpTips() { registerHelpTips(AUDIT_HELP_TIPS); }
