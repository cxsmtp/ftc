"use strict";

// THE EVENT TEAM'S PERSONA REPORTS — when and how they are sent.
// (The data is lib/event-team.js; the qualifying rule lib/qualifying.js.)
//
// FOUR PERSONAS + MANAGERS, ONE EMAIL EACH, EACH OPENING WITH ONE CALL TO ACTION
// (the single link `buildEmail` renders; the body links nowhere else) and listing
// only what needs action:
//   se        — the challenge to fix, too easy / too hard flags, bounced
//               certificate emails, low ratings, the challenge table, podium and
//               certificates issued / delivered. A repeated wrong answer is quoted
//               only for an UNSEALED challenge (a sealed answer reaches only its
//               author and a superadmin, never a mail).
//   marketing — leads against the target, new / returning / possible duplicate,
//               the qualifying breakdown, the top hot leads with where they came
//               from, the opted-out marked "do not email"; the CRM CSV attached
//               (none while nobody has taken part).
//   sales     — accounts (leads grouped by normalised company), most senior title,
//               best answers, signal.
//   sdr       — each SDR their own share only (Marketing when there is no SDR):
//               cards, each lead's email address, qualifying answers first, what
//               they did, their free-text answers, a template-built opener (no
//               AI), and — for an SDR — a file of THEIR leads attached (not on
//               the 48 h reminder; Marketing standing in has the CRM file) —
//               operator ruling 79, 14 Nov 2026.
//   manager   — a one-screen scorecard against the targets and the average of the
//               last three ended events of the same kind.
// CTAs are absolute BASE_URL links into the event workspace (sign-in required;
// they carry no capability). Each says what to do ("Download the CRM file (12
// leads)", `Edit "Account Timeline"`, "Contact Ann Lee first") beside the reason.
// A recipient whose address is not an account that can open the event is sent
// no button and no link: the step in words they can act on without the page
// ("Load the attached file … into the CRM" for "Download the CRM file …";
// ruling 79).
// What each persona is told and how it is drawn: lib/team-report-mail.js.
//
// WHEN (the certificate-dispatch durable-job shape; lib/certificate-dispatch.js):
//   • wrapup — every end path already calls `enqueueCertificateDispatch`; that one
//     function calls `enqueueTeamReport` too, so no end path can be missed. Due at
//     the effective end + 15 minutes; the worker re-checks at run time, so an
//     event revived meanwhile mails nobody (the job is dropped; the next end
//     re-enqueues). A Booth Event whose late-entry window is still open gets a
//     delta job at the window's close.
//   • delta   — after a wrapup already ran: Close late entries now, the late
//     window lapsing, or the event ending again after an extension. Only the
//     leads never reported before (`event_leads.first_reported_at` NULL); nothing
//     new, nothing sent.
//   • weekly  — a Program, while it runs: a Monday digest (the first pass on or
//     after Monday 00:00 UTC of a week the Program had started before); the
//     wrap-up at its deadline.
//   • nudge   — 48 hours after a wrapup, to the owners of HOT leads nobody has
//     marked contacted and who have not opted out (`isContactable`), and a count
//     to Marketing; nothing when no such lead is waiting. Like every kind, it is
//     dropped when its event has been revived (sweep #85: it once ran before that
//     check); the end that follows queues it again (its report: the `end:` delta
//     of a re-end), once only: never after a reminder has reached anyone (one
//     that ran with nobody waiting, or reached nobody, does not count).
// RESTORED (operator ruling, 17 Nov 2026, "Choose at restore"): after a restore
// whose step 4 chose mark-sent (`settings.restore_mail_floor_at`, read through
// lib/certificate-dispatch.js `restoreMailFloor`), a wrapup, delta or nudge of an
// event that ended before that floor is dropped, and the Monday digest of the
// week the restore happened in counts as sent: they went out in the timeline the
// restore discarded. Events ending after it, and Send now, are unaffected.
// NEVER TWICE: `team_report_runs` holds one row per (event, kind, end instance),
// and `team_report_sends` one per (event, kind, end instance, recipient, persona),
// written `sending` BEFORE the send. The run row comes after the sends (the
// "reported" stamp at the first delivery: below), so a cut run keeps its job and
// its re-run reaches only those not yet claimed. AT MOST ONCE across a crash: boot marks a row still `sending`
// as `unknown` and nothing retries it. Dry-run events and
// events with an empty team send nothing. Under test nothing runs by itself:
// `POST /api/test/team-report-tick` drives one pass.
// A REMOVED MEMBER LEAVES THE LEDGER (sweep #149; operator ruling, 24 Nov 2026).
// Organisers read the ledger as the Team section's recent sends, so once an
// address holds no role on an event's team, that event's rows for it are
// rewritten to `removedRecipient` (its `tm_` fingerprint and domain, what the
// mail's own `email_sent` row records) and shown as "removed member (<domain>)".
// The rows a member removed by an older release left under the address were
// rewritten the same way once, at boot (db.js, marker
// `team_report_removed_recipients_at`), with the form the live paths use
// (lib/team-recipient.js).
// The ledger keeps its two jobs: the address added back takes its rows back
// (`restoreRemovedRecipient`), so it is never sent a run it already received,
// and the 48-hour reminder's "went out" check reads no address. A claim sends
// nothing to an address that no longer holds the role its message was composed
// for (removed since its pass began: no row is written), and a send in flight
// when its member is removed settles on the rewritten row.
// A FAILED SEND IS RETRIED (a relay down at wrap-up time must not lose the
// report): a job whose run had a failed send keeps its job and runs again after
// a back-off, up to `MAX_PASSES` passes; only a `failed` ledger row is claimed
// again, so whoever received it is never sent it twice. The run row is written
// when nothing failed or on the last pass. A weekly digest is one pass (it has
// no job), as is Send now (an admin's request, answered in full).
// "REPORTED" MEANS RECEIVED: a run's leads are stamped `first_reported_at` at
// its FIRST delivery (the ledger's `sent_at`), and only the leads that pass
// built — exactly what its recipients got. A later pass of the same run (a
// retry, a re-run after a shutdown) stamps nothing: somebody who joined since is
// in no report the others received, so they stay unreported and the next delta
// carries them to everyone (a wrap-up that leaves such leads behind once the
// late window has closed queues that delta itself). A delta's later pass sends
// its own first pass's leads again (`first_reported_at` equal to that first
// delivery), so a recipient who was retried gets what the others got. A run
// nobody received stamps nothing.
//
// SEND NOW (`runManualReport`) answers within `SEND_NOW_DEADLINE_MS`, the 10 s
// fan-out rule: what is still going out carries on after the answer (the
// shutdown drain waits for it), and a second press while one runs is refused
// (`manualRunInFlight`), so nobody is sent a second full report and lead file.
//
// A PASS THAT THROWS (the report cannot be built or its bookkeeping written) is
// retried the same way, and after `MAX_PASSES` passes given up: the job is
// dropped and `team_report_given_up` goes on the event's History.
// TRANSACTIONAL, NOT BULK: these are internal staff emails to the event team
// (reason `event_team_report`), never to participants, and only to the allowed
// domains: no unsubscribe link; each mail's footer says to ask the event's
// organiser to be removed (operator ruling, 24 Nov 2026). Each send is recorded by
// `sendEmailLogged` and, per run, a `team_report_sent` event on the event's History.

const db = require("../db");
const { now } = require("./time");
const { log } = require("./log");
const { swallowed } = require("./best-effort");
const T = require("./event-team");
const { removedRecipient, recipientLabel } = require("./team-recipient");
const M = require("./team-report-mail");
const { DEFAULT_QUALIFYING } = require("./qualifying");
const { previewHtml } = M;

const SIGNAL = { hot: "Hot", warm: "Warm", cold: "Cold" };
const STATUS = { new: "New", returning: "Returning", possible_duplicate: "Possible duplicate" };

const SETTLE_MS = 15 * 60_000;
const NUDGE_AFTER_MS = 48 * 3600_000;
const TICK_MS = 60_000;
// A run with a failed send: passes in all, and the wait before each retry.
const MAX_PASSES = 3;
const RETRY_BACKOFF_MS = [5 * 60_000, 30 * 60_000];
const SEND_NOW_DEADLINE_MS = 10_000;

let _running = null;
let _interval = null;
let _stopping = false;
// Send now runs in flight, by event id (one at a time per event).
const _manual = new Map();

function _nowIso() { return now().toISOString(); }

function _isDryRun(compId) {
  try { return require("./competitions").isDryRunCompetition(compId); } catch (_) { return true; }
}

function _upsertJob(compId, kind, endKey, dueMs) {
  db.prepare(
    `INSERT INTO team_report_jobs (competition_id, kind, end_key, due_at, enqueued_at, passes) VALUES (?,?,?,?,?,0)
     ON CONFLICT(competition_id, kind) DO UPDATE SET end_key=excluded.end_key, due_at=excluded.due_at, enqueued_at=excluded.enqueued_at, passes=0, last_error=NULL`
  ).run(compId, kind, endKey, new Date(dueMs).toISOString(), _nowIso());
}
function _hasRun(compId, kind, endKey) {
  return !!db.prepare(`SELECT 1 FROM team_report_runs WHERE competition_id=? AND kind=?${endKey ? " AND end_key=?" : ""} LIMIT 1`).get(...(endKey ? [compId, kind, endKey] : [compId, kind]));
}
// Whether a 48-hour reminder about this event has reached anyone, or may have (a
// send a restart cut is `unknown`, one in flight `sending`): never twice. A
// reminder that RAN with nobody waiting, or whose every send failed or was
// refused, reached nobody, so the next end's report queues one (sweep #85).
function _nudgeWentOut(compId) {
  return !!db.prepare("SELECT 1 FROM team_report_sends WHERE competition_id=? AND kind='nudge' AND status IN ('sent','unknown','sending') LIMIT 1").get(compId);
}

/**
 * Called from `enqueueCertificateDispatch` (every end path) with the event row.
 * Best-effort and synchronous; never throws.
 */
function enqueueTeamReport(comp, reason) {
  try {
    if (!comp) return false;
    const { competitionFullyEnded, competitionEffectiveEnd } = require("./competitions");
    const endedAtMs = comp.ended_at ? Date.parse(comp.ended_at) : NaN;
    const hardEnded = Number.isFinite(endedAtMs) && endedAtMs <= now().getTime()
      && !db.prepare("SELECT 1 FROM competition_timeslots WHERE competition_id=? LIMIT 1").get(comp.id);
    if (!hardEnded && !competitionFullyEnded(comp)) return false;
    const effEnd = competitionEffectiveEnd(comp) || now();
    const t = now().getTime();
    if (reason === "late_entry_closed") {
      if (!_hasRun(comp.id, "wrapup")) return false;     // the wrapup will include them
      const key = `late:${comp.late_entry_deadline_at || effEnd.toISOString()}`;
      const at = Date.parse(comp.late_entry_deadline_at) || t;
      _upsertJob(comp.id, "delta", key, Math.max(t, at) + SETTLE_MS);
      return true;
    }
    const endKey = effEnd.toISOString();
    // A second end after a wrapup (extension, re-end): only the changes.
    if (_hasRun(comp.id, "wrapup") && !_hasRun(comp.id, "wrapup", endKey)) {
      _upsertJob(comp.id, "delta", `end:${endKey}`, Math.max(t, effEnd.getTime()) + SETTLE_MS);
      return true;
    }
    _upsertJob(comp.id, "wrapup", endKey, Math.max(t, effEnd.getTime()) + SETTLE_MS);
    return true;
  } catch (e) {
    try { log.warn({ competition_id: comp && comp.id, err: e.message }, "team reports: enqueue failed"); } catch (e2) { swallowed("team-reports:enqueue-log", e2); }
    return false;
  }
}

// Jobs are due 15 minutes out, so the interval picks them up: nothing is kicked.
// A Send now still going out after its answer counts too (the shutdown drain).
function teamReportsBusy() { return !!_running || _manual.size > 0; }

// ─────────────────────────────────────────────────────────────────────────────
// Composition
// ─────────────────────────────────────────────────────────────────────────────

/** The CRM file: one row per person (lib/csv.js neutralises formulas). */
// The lead file's header row never varies by event: a CRM import maps columns by
// header. One column per built-in question (in their defined order, labelled as
// the app labels them, blank where the event does not ask it), and an
// organiser's own questions together in "Other answers" as "question: answer".
const QUALIFYING_CSV_LABEL = { developers: "Developers", scanner: "Code scanner", evaluating: "Evaluating", follow_up: "Follow-up" };
const QUALIFYING_CSV_KEYS = DEFAULT_QUALIFYING.map(q => q.key);

function crmCsv(data, leads) {
  const { csvBuffer } = require("./csv");
  const own = data.qualifying.filter(q => !QUALIFYING_CSV_KEYS.includes(q.key));
  const headers = ["First name", "Last name", "Title", "Company", "Country", "Email",
    ...QUALIFYING_CSV_KEYS.map(k => QUALIFYING_CSV_LABEL[k]), "Other answers", "Signal", "New or returning", "First seen event", "First seen source",
    "Source at this event", "Other events", "Opted out (do not email)", "Score"];
  const rows = leads.map(l => [l.first_name, l.last_name, l.title, l.company, l.country, l.email,
    ...QUALIFYING_CSV_KEYS.map(k => l.answers[k] || ""),
    own.filter(q => l.answers[q.key]).map(q => `${q.title}: ${l.answers[q.key]}`).join("; "),
    SIGNAL[l.signal], STATUS[l.status], l.first_seen_event, l.first_seen_source || "",
    l.source, l.other_events.join("; "), l.opted_out ? "Yes" : "No", l.score]);
  return csvBuffer(headers, rows);
}

/**
 * Lead and hot counts of the last three ended events of the same kind (before this
 * one). `scopeIds` narrows them to a scoped actor's events (`scopedCompetitionIds`:
 * null is everything, [] nothing), since an average of one other event is that
 * event's figures. A sent report narrows each manager's own (`managerPeerScope`).
 *
 * KEPT for `PEER_CACHE_MS` per (event, scope): it rebuilds up to three other
 * events' whole reports, and those events have ENDED, so their figures do not
 * move; a manager reopening the view, a preview and the mail then cost a
 * lookup. A newly ended event joins the comparison within that window. Only a
 * computed answer is kept (a throw is not).
 */
const PEER_CACHE_MS = 5 * 60_000;
const PEER_CACHE_MAX = 500;
const _peerCache = new Map();
function peerAverage(comp, scopeIds = null) {
  const key = `${comp.id}|${scopeIds === null ? "*" : JSON.stringify([...scopeIds].map(String).sort())}`;
  const hit = _peerCache.get(key);
  if (hit && Date.now() - hit.at < PEER_CACHE_MS) return hit.value;
  const value = _computePeerAverage(comp, scopeIds);
  _peerCache.delete(key);
  _peerCache.set(key, { at: Date.now(), value });
  while (_peerCache.size > PEER_CACHE_MAX) _peerCache.delete(_peerCache.keys().next().value);
  return value;
}
function _computePeerAverage(comp, scopeIds) {
  const { competitionFullyEnded } = require("./competitions");
  const rows = db.prepare(
    `SELECT id FROM competitions WHERE event_kind=? AND id != ? AND start_time < ?
       AND (? IS NULL OR id IN (SELECT value FROM json_each(?)))
     ORDER BY start_time DESC LIMIT 12`
  ).all(comp.event_kind, comp.id, comp.start_time, scopeIds ? 1 : null, JSON.stringify(scopeIds || []));
  const picked = [];
  for (const r of rows) {
    if (picked.length >= 3) break;
    const c = require("./competitions").getCompetition(r.id);
    if (c && competitionFullyEnded(c) && !_isDryRun(c.id)) picked.push(c.id);
  }
  if (!picked.length) return null;
  const sum = { leads: 0, hot: 0, new: 0, played: 0 };
  for (const id of picked) {
    const d = T.buildReportData(id);
    if (!d) continue;
    const s = T.summarise(d);
    for (const k of Object.keys(sum)) sum[k] += s[k];
  }
  return { events: picked.length, leads: sum.leads / picked.length, hot: sum.hot / picked.length, new: sum.new / picked.length, played: sum.played / picked.length };
}

/**
 * THE EVENTS A MANAGER'S COMPARISON MAY COVER (sweep #80): what whoever APPOINTED
 * them may open now, never more. An organiser scoped to their events who puts an
 * address on the team (their own, an alias, anyone's) must not be mailed the
 * figures of events they cannot see, as the in-app view and the preview never
 * show them. So the scope is the appointer's (`added_by`, read live by
 * `memberEventScope`, the rule the reports' button follows: an account acting on
 * every event, or the built-in superadmin, sees them all; one scoped to its
 * events, those; an address that is no such account now, none), narrowed again
 * to the manager's own events when their address is itself an account scoped to
 * its events, and to a preview's reader (`readerScope`). null is every event,
 * [] none.
 */
function managerPeerScope(member, readerScope) {
  const parts = [];
  const by = typeof member.added_by === "string" ? member.added_by.trim() : "";
  parts.push(by === "superadmin" ? null : T.memberEventScope(by));
  const { findUserByPrimary } = require("./account-lookup");
  const own = findUserByPrimary(db, typeof member.email === "string" ? member.email.trim() : "", "id, role");
  if (own && require("./rbac").roleClass(own.role) === "granted") parts.push(T.memberEventScope(member.email));
  if (readerScope !== undefined) parts.push(readerScope);
  let out = null;
  for (const p of parts) {
    if (p === null || p === undefined) continue;
    out = out === null ? [...p] : out.filter(id => p.includes(id));
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Sending
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build every message one run would send: [{member, persona, subject, html, text, attachments}].
 * `onlyPersona` builds that persona's messages alone (a preview, a one-persona
 * Send now): the managers' comparison, which rebuilds three other events'
 * reports, is then read only when the managers' report is wanted.
 */
function composeRun(data, members, kind, { newLeadIds = null, onlyPersona = null, readerScope } = {}) {
  // `readerScope`: a preview's reader, as `scopedCompetitionIds` answers (null:
  // every event); absent for a run, whose readers are its recipients alone.
  const readerCanSee = readerScope === undefined ? null : T.canSeeScope(readerScope);
  const platformName = require("./settings").getPlatformName();
  const owners = T.leadOwners(members);
  const ownerMap = T.splitLeads(data.leads, owners);
  for (const l of data.leads) l.owner_member_id = ownerMap.get(l.user_id) || null;
  const delta = kind === "delta";
  const scope = newLeadIds ? data.leads.filter(l => newLeadIds.has(l.user_id)) : data.leads;
  const out = [];
  const want = (persona) => !onlyPersona || onlyPersona === persona;
  // Operator ruling 79 (14 Nov 2026) — the call to action is a button only for
  // a recipient whose address opens the event (lib/event-team.js
  // `memberOpensEvent`), asked once per address per run; anyone else reads it
  // in words. And an SDR's file holds THEIR leads (`fileLeads`), Marketing's the
  // run's.
  const opens = new Map();
  const opensFor = (m) => {
    const k = String(m.email || "").toLowerCase();
    if (!opens.has(k)) opens.set(k, T.memberOpensEvent(m.email, data.comp.id));
    return opens.get(k);
  };
  // Operator ruling, 15 Nov 2026 — a lead row names the person's other events
  // only where the RECIPIENT's account may open them (no account: none), and a
  // preview (`readerCanSee`, the reader's scope) never more than its reader may
  // see. One view per address per run, built after the owners are set, so every
  // builder below reads the recipient's rows, never the unnarrowed ones.
  const views = new Map();
  const viewFor = (m) => {
    const k = String(m.email || "").toLowerCase();
    if (!views.has(k)) {
      const mine = T.canSeeScope(T.memberEventScope(m.email));
      views.set(k, T.reportForReader(data, readerCanSee ? (cid) => mine(cid) && readerCanSee(cid) : mine));
    }
    return views.get(k);
  };
  const rowsOf = (v, leads) => { const ids = new Set(leads.map(l => l.user_id)); return v.leads.filter(l => ids.has(l.user_id)); };
  const push = (member, persona, build, fileLeads = scope) => {
    const v = viewFor(member);
    const r = build(v, rowsOf(v, scope));
    fileLeads = rowsOf(v, fileLeads);
    const link = opensFor(member);
    const { html, text } = M.renderMail(platformName, v.comp.name, member, r, T.ROLE_LABELS[member.role], { link });
    const attachments = r.csv ? [{ filename: `${persona === "sdr" ? "your-leads" : "leads"}-${v.comp.id.slice(0, 8)}${delta ? "-new" : ""}.csv`, content: crmCsv(v, fileLeads), contentType: "text/csv; charset=utf-8" }] : undefined;
    out.push({ member, persona, subject: `${platformName} — ${r.subject}`, html, text, attachments, cta: r.cta, link });
  };
  if (kind === "nudge") {
    // Only hot leads somebody may still reach (lib/event-team.js `isContactable`:
    // not contacted, not opted out; operator ruling, 14 Nov 2026): an owner whose
    // waiting hot leads all opted out is sent nothing, as their report said.
    const waitingHot = (l) => l.signal === "hot" && T.isContactable(l);
    for (const o of owners) {
      const mine = data.leads.filter(l => l.owner_member_id === o.id && waitingHot(l));
      if (mine.length && want("sdr")) push(o, "sdr", (v) => M.sdrReport(v, rowsOf(v, mine), { nudge: true }));
    }
    // Marketing owns the leads overall: told how many are waiting, when it does not own them itself.
    const waiting = data.leads.filter(waitingHot).length;
    if (waiting && want("marketing")) {
      const ownerIds = new Set(owners.map(o => o.id));
      for (const m of members) {
        if (m.role !== "marketing" || ownerIds.has(m.id)) continue;
        push(m, "marketing", (v) => M.marketingNudge(v, waiting));
      }
    }
    return { messages: out, ownerMap };
  }
  if (delta && !scope.length) return { messages: out, ownerMap };
  // Each manager's comparison covers the events their appointer may open, and a
  // preview's never more than its reader may see (`managerPeerScope`). It
  // rebuilds other events' reports, so it is read only when a manager's report is
  // built, once per scope a run (none at all for a scope of no events).
  const peers = new Map();
  const peerFor = (m) => {
    const sc = managerPeerScope(m, readerScope);
    const k = sc === null ? "*" : JSON.stringify([...sc].map(String).sort());
    if (!peers.has(k)) peers.set(k, sc !== null && !sc.length ? null : peerAverage(data.comp, sc));
    return peers.get(k);
  };
  for (const m of members) {
    if (m.role === "se" && !delta && want("se")) push(m, "se", (v) => M.seReport(v));
    if (m.role === "marketing" && want("marketing")) push(m, "marketing", (v, vs) => M.marketingReport(v, vs, { delta }));
    if (m.role === "sales" && want("sales")) push(m, "sales", (v, vs) => M.salesReport(v, vs, { delta }));
    if (T.MANAGER_ROLES.has(m.role) && want("manager")) push(m, "manager", (v) => M.managerReport(v, owners, peerFor(m)));
  }
  for (const o of owners) {
    const mine = scope.filter(l => l.owner_member_id === o.id);
    if (mine.length && want("sdr")) push(o, "sdr", (v) => M.sdrReport(v, rowsOf(v, mine), { delta, file: o.role === "sdr" }), mine);
  }
  return { messages: out, ownerMap };
}

// ─────────────────────────────────────────────────────────────────────────────
// A removed member in the ledger (sweep #149; see the header)
// ─────────────────────────────────────────────────────────────────────────────

// The ledger's name for an address that has left the event's team, and how the
// Team read shows it, are lib/team-recipient.js `removedRecipient` and
// `recipientLabel`: one definition, which db.js shares for its one-shot rewrite
// of the rows an older release left under a removed member's address.
/**
 * The member DELETE, in its transaction, once the member row is gone: when the
 * address holds no other role on this event's team, the event's ledger rows
 * for it take the removed form. Returns how many rows it rewrote.
 */
function forgetRemovedRecipient(compId, email) {
  if (db.prepare("SELECT 1 FROM event_team_members WHERE competition_id=? AND email=? LIMIT 1").get(compId, email)) return 0;
  return db.prepare("UPDATE team_report_sends SET recipient=? WHERE competition_id=? AND recipient=?")
    .run(removedRecipient(email), compId, email).changes;
}
/**
 * The member POST, in its transaction: the address back on the team takes its
 * rows back, so a claim by address finds what it was already sent (never twice)
 * and a `failed` one is retried. Returns how many rows it restored.
 */
function restoreRemovedRecipient(compId, email) {
  return db.prepare("UPDATE team_report_sends SET recipient=? WHERE competition_id=? AND recipient=?")
    .run(email, compId, removedRecipient(email)).changes;
}

async function _sendOne(compId, kind, endKey, msg) {
  const email = require("./email");
  const ts = _nowIso();
  // The claim. A row already in the ledger is skipped (sent, refused, in flight,
  // or `unknown` after a crash: never twice) — except a `failed` one, which a
  // retry claims again. A member removed from the team since this pass was
  // composed is sent nothing and gets no row (sweep #149: the address leaves the
  // ledger with them): the address must still hold the role the message was
  // composed for, asked in the same statement.
  const ins = db.prepare(
    `INSERT INTO team_report_sends (competition_id, kind, end_key, recipient, persona, status, created_at)
     SELECT ?,?,?,?,?,'sending',? WHERE EXISTS (SELECT 1 FROM event_team_members WHERE competition_id=? AND email=? AND role=?)
     ON CONFLICT(competition_id, kind, end_key, recipient, persona) DO UPDATE SET status='sending', created_at=excluded.created_at, sent_at=NULL
     WHERE team_report_sends.status='failed'`
  ).run(compId, kind, endKey, msg.member.email, msg.persona, ts, compId, msg.member.email, msg.member.role);
  if (ins.changes !== 1) return "skipped";
  let status = "failed";
  try {
    // The allow-list is asked again at SEND time: a domain removed since the
    // member was added stops the mail.
    if (!T.addressAllowed(msg.member.email)) { status = "refused"; return status; }
    const ok = await require("./util").trackDetachedSend(email.sendEmailLogged(null, {
      to: msg.member.email, subject: msg.subject, html: msg.html, text: msg.text,
      ...(msg.attachments ? { attachments: msg.attachments } : {}),
    }, "event_team_report").catch(() => false));
    status = ok ? "sent" : "failed";
    return status;
  } finally {
    try {
      // By the address or its removed form: a member removed while this send was
      // in flight has had the row rewritten (sweep #149), and it must still settle.
      db.prepare("UPDATE team_report_sends SET status=?, sent_at=CASE WHEN ?='sent' THEN ? ELSE NULL END WHERE competition_id=? AND kind=? AND end_key=? AND persona=? AND recipient IN (?, ?)")
        .run(status, status, _nowIso(), compId, kind, endKey, msg.persona, msg.member.email, removedRecipient(msg.member.email));
    } catch (e) { swallowed("team-reports:ledger-settle", e); }
  }
}

// When one run (event, kind, end instance) first reached somebody: the earliest
// `sent_at` in its ledger, or null while nobody has received it.
function _firstDelivered(compId, kind, endKey) {
  const r = db.prepare("SELECT MIN(sent_at) AS at FROM team_report_sends WHERE competition_id=? AND kind=? AND end_key=? AND status='sent'").get(compId, kind, endKey);
  return (r && r.at) || null;
}

/**
 * Run one report for an event now. `kind`: wrapup | delta | weekly | nudge |
 * manual. Returns { sent, failed, refused, skipped, messages }, plus `retry`
 * when a send failed and `finalAttempt` is false (the job keeps its run for the
 * next pass), and — for a wrap-up or delta somebody received — `unreported`,
 * the leads no delivered copy of it holds. Records the run (except manual,
 * which is an admin's explicit act and carries its own key).
 */
async function runReport(compId, kind, endKey, { actor = "system", context = {}, onlyPersona = null, finalAttempt = true } = {}) {
  const out = { sent: 0, failed: 0, refused: 0, skipped: 0, messages: 0, leads: 0 };
  const data = T.buildReportData(compId);
  if (!data) return out;
  const members = T.listMembers(compId);
  const markReported = kind === "wrapup" || kind === "delta";
  // An earlier pass of THIS run already reached somebody: its leads carry that
  // delivery's instant as their stamp (null: nobody has received it yet).
  let stampedAt = markReported ? _firstDelivered(compId, kind, endKey) : null;
  // The leads a delta reports: never reported before, plus (on a later pass)
  // those its own first delivery stamped, so a retried recipient gets them too.
  let newLeadIds = null;
  if (kind === "delta") newLeadIds = new Set(data.leads.filter(l => !l.first_reported_at || (stampedAt && l.first_reported_at === stampedAt)).map(l => l.user_id));
  const { messages, ownerMap } = composeRun(data, members, kind, { newLeadIds, onlyPersona });
  out.leads = newLeadIds ? newLeadIds.size : data.leads.length;
  // What this pass's messages carry, and so what its first delivery stamps.
  const passLeads = newLeadIds ? data.leads.filter(l => newLeadIds.has(l.user_id)) : data.leads;
  const stampedNow = new Set();
  // Owners are stored first, whatever happens next, so the split is stable.
  db.transaction(() => { T.persistLeadOwners(compId, data.leads, ownerMap); })();
  const todo = messages;
  out.messages = todo.length;
  for (const m of todo) {
    if (_stopping) { out.interrupted = true; break; }
    const st = await _sendOne(compId, kind, endKey, m);
    if (st === "sent") {
      out.sent++;
      // The run's FIRST delivery: this pass's leads are reported, at the instant
      // the ledger gives it. Every recipient of this pass gets exactly them; a
      // later pass stamps nothing (see the header: REPORTED MEANS RECEIVED).
      if (markReported && !stampedAt) {
        stampedAt = _firstDelivered(compId, kind, endKey);
        if (stampedAt) {
          db.transaction(() => { T.persistLeadOwners(compId, passLeads, ownerMap, { markReported: true, at: stampedAt }); })();
          for (const l of passLeads) if (!l.first_reported_at) stampedNow.add(l.user_id);
        }
      }
    } else if (st === "refused") out.refused++; else if (st === "skipped") out.skipped++; else out.failed++;
  }
  // The run row comes AFTER the sends: a run cut by a shutdown or a crash keeps
  // its job, and the re-run reaches the rest of the team (the ledger skips
  // everyone already claimed). A failed send before the last pass does the
  // same: the next pass retries it.
  if (out.interrupted) return out;
  if (out.failed && !finalAttempt) { out.retry = true; return out; }
  // Leads in this pass that no delivered report of this run holds (they joined
  // after its first delivery): the caller queues the delta that carries them.
  if (markReported && stampedAt) out.unreported = data.leads.filter(l => !l.first_reported_at && !stampedNow.has(l.user_id)).length;
  if (kind !== "manual") db.prepare("INSERT OR IGNORE INTO team_report_runs (competition_id, kind, end_key, ran_at) VALUES (?,?,?,?)").run(compId, kind, endKey, _nowIso());
  try {
    const { recordCompetitionEvent } = require("./audit");
    if (db.prepare("SELECT 1 FROM competitions WHERE id=?").get(compId)) {
      recordCompetitionEvent(compId, "team_report_sent", actor, {
        kind, end_key: endKey, leads: out.leads, messages: out.messages, sent: out.sent, failed: out.failed, refused: out.refused, ...context,
      });
    }
  } catch (e) { swallowed("team-reports:audit", e); }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// The worker
// ─────────────────────────────────────────────────────────────────────────────

function _dropJob(job) {
  db.prepare("DELETE FROM team_report_jobs WHERE competition_id=? AND kind=? AND enqueued_at=?").run(job.competition_id, job.kind, job.enqueued_at);
}

// A pass with a failed send: count it and come back after the back-off.
function _retryJob(job, out) {
  const wait = RETRY_BACKOFF_MS[Math.min(job.passes || 0, RETRY_BACKOFF_MS.length - 1)];
  db.prepare("UPDATE team_report_jobs SET passes=passes+1, last_error='send_failed', due_at=? WHERE competition_id=? AND kind=? AND enqueued_at=?")
    .run(new Date(now().getTime() + wait).toISOString(), job.competition_id, job.kind, job.enqueued_at);
  out.retried++;
}
function _finalPass(job) { return (job.passes || 0) + 1 >= MAX_PASSES; }

// A pass that THREW (not a failed send: the report could not be built or its
// bookkeeping written). Retried like a failed send, up to `MAX_PASSES` passes in
// all, then given up: the job is dropped, a warning logged, and the event's
// History says so (`team_report_given_up`), where its organisers look for its
// reports, since nothing else tells them the report never went. Both writes
// match `enqueued_at`, so a job re-queued while the pass ran is left alone.
function _crashedJob(job) {
  const passes = (job.passes || 0) + 1;
  if (passes < MAX_PASSES) {
    db.prepare("UPDATE team_report_jobs SET passes=passes+1, last_error='internal_error', due_at=? WHERE competition_id=? AND kind=? AND enqueued_at=?")
      .run(new Date(now().getTime() + 30 * 60_000).toISOString(), job.competition_id, job.kind, job.enqueued_at);
    return;
  }
  const gone = db.prepare("DELETE FROM team_report_jobs WHERE competition_id=? AND kind=? AND enqueued_at=?").run(job.competition_id, job.kind, job.enqueued_at);
  if (!gone.changes) return;
  try { log.warn({ competition_id: job.competition_id, kind: job.kind, end_key: job.end_key, passes }, "team reports: a report failed on every pass and is given up"); } catch (e) { swallowed("team-reports:given-up-log", e); }
  try {
    const { recordCompetitionEvent } = require("./audit");
    if (db.prepare("SELECT 1 FROM competitions WHERE id=?").get(job.competition_id)) {
      recordCompetitionEvent(job.competition_id, "team_report_given_up", "system", { kind: job.kind, end_key: job.end_key, passes, error: "internal_error" });
    }
  } catch (e) { swallowed("team-reports:given-up-audit", e); }
}

async function _processJob(job, out) {
  const C = require("./competitions");
  const comp = C.getCompetition(job.competition_id);
  if (!comp) { _dropJob(job); out.dropped++; return; }
  if (_isDryRun(comp.id) || !T.listMembers(comp.id).length) { _dropJob(job); out.dropped++; return; }
  // A mark-sent restore: anything about an end before it already went out.
  const _restored = require("./certificate-dispatch").restoreMailFloor();
  if (_restored) {
    const _end = C.competitionEffectiveEnd(comp);
    if (_end && _end.toISOString() < _restored) { _dropJob(job); out.dropped++; return; }
  }
  // Every kind (wrapup, delta, nudge): the event must STILL be over. A revive
  // drops the job, and the next end's report queues what is still owed. Asked
  // before the nudge branch (sweep #85): a reminder about leads "waiting" since
  // an end that a reopened event undid is mail about an event still running.
  if (!C.competitionFullyEnded(comp)) { _dropJob(job); out.dropped++; return; }
  if (job.kind === "nudge") {
    if (_hasRun(comp.id, "nudge", job.end_key)) { _dropJob(job); out.dropped++; return; }
    const r = await runReport(comp.id, "nudge", job.end_key, { finalAttempt: _finalPass(job) });
    out.sent += r.sent; out.runs++;
    if (r.interrupted) return;
    if (r.retry) { _retryJob(job, out); return; }
    _dropJob(job);
    return;
  }
  if (job.kind === "wrapup") {
    const effEnd = C.competitionEffectiveEnd(comp);
    if (!effEnd || effEnd.toISOString() !== job.end_key) { _dropJob(job); out.dropped++; return; }
  }
  if (job.kind === "delta" && job.end_key.startsWith("late:")) {
    // Late entrants are still coming: wait for the window to close.
    const effEnd = C.competitionEffectiveEnd(comp);
    const dl = require("./late-entry").lateEntryDeadline(comp, effEnd);
    if (dl && dl.getTime() > now().getTime()) {
      db.prepare("UPDATE team_report_jobs SET due_at=?, end_key=? WHERE competition_id=? AND kind=? AND enqueued_at=?")
        .run(new Date(dl.getTime() + SETTLE_MS).toISOString(), `late:${dl.toISOString()}`, job.competition_id, job.kind, job.enqueued_at);
      out.deferred++;
      return;
    }
  }
  if (_hasRun(comp.id, job.kind, job.end_key)) { _dropJob(job); out.dropped++; return; }
  const r = await runReport(comp.id, job.kind, job.end_key, { finalAttempt: _finalPass(job) });
  out.sent += r.sent; out.runs++;
  if (r.interrupted) return;
  if (r.retry) { _retryJob(job, out); return; }
  _dropJob(job);
  // An END'S report — the wrap-up, or the delta of a later end (an extension,
  // a re-end) — queues the delta at the close of a late window still open: that
  // end's own delta replaced any one pending, so without this nobody who walks
  // up in the new window is reported when it lapses by itself.
  const endRun = job.kind === "wrapup" || (job.kind === "delta" && job.end_key.startsWith("end:"));
  if (endRun) {
    // The 48 h nudge follows an end's report: the wrap-up, or a re-end's `end:`
    // delta while no reminder about the event has gone out (a revive dropped the
    // one pending, sweep #85), never a second one.
    if (job.kind === "wrapup" || !_nudgeWentOut(comp.id)) _upsertJob(comp.id, "nudge", job.end_key, now().getTime() + NUDGE_AFTER_MS);
    // Read again after the run's awaits: an end or a close during the run has
    // queued its own delta (one slot per event), which this must not overwrite.
    const fresh = C.getCompetition(comp.id) || comp;
    const pendingDelta = !!db.prepare("SELECT 1 FROM team_report_jobs WHERE competition_id=? AND kind='delta'").get(comp.id);
    const effEnd = C.competitionEffectiveEnd(fresh);
    const dl = require("./late-entry").lateEntryDeadline(fresh, effEnd);
    // A delta already pending reports whoever is still unreported.
    if (!pendingDelta) {
      if (dl && dl.getTime() > now().getTime()) _upsertJob(comp.id, "delta", `late:${dl.toISOString()}`, dl.getTime() + SETTLE_MS);
      // The window has closed (or there is none) while people joined after the
      // wrap-up first went out (it was retried meanwhile): no close is left to
      // queue their delta, so the wrap-up does.
      else if (job.kind === "wrapup" && r.unreported) _upsertJob(comp.id, "delta", `late:${(dl || effEnd || now()).toISOString()}`, now().getTime() + SETTLE_MS);
    }
  }
}

/** Mondays: one digest per running Program per ISO week (Monday 00:00 UTC). */
async function _weeklyDigests(out) {
  const C = require("./competitions");
  const { eventPolicy } = require("./event-policy");
  const n = now();
  const monday = new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate() - ((n.getUTCDay() + 6) % 7)));
  const key = monday.toISOString().slice(0, 10);
  // The week a mark-sent restore happened in: its digest went out before it.
  const _restored = require("./certificate-dispatch").restoreMailFloor();
  if (_restored && _restored > monday.toISOString()) return;
  const comps = db.prepare("SELECT DISTINCT competition_id AS id FROM event_team_members").all();
  for (const { id } of comps) {
    if (_stopping) break;
    const comp = C.getCompetition(id);
    if (!comp || eventPolicy(comp).schedule !== "deadline") continue;
    if (C.competitionStatus(comp) !== "live" || _isDryRun(id)) continue;
    if (!(Date.parse(comp.start_time) < monday.getTime())) continue;
    if (_hasRun(id, "weekly", key)) continue;
    const r = await runReport(id, "weekly", key);
    out.sent += r.sent; out.runs++;
  }
}

// MAIL WAITS WHILE THE INSTANCE IS OUT OF SERVICE: maintenance mode is on
// (operator ruling, 17 Nov 2026), or the database failed its boot integrity or
// schema check (ruling, 24 Nov 2026). server.js hands in its one instance-health
// gate (`_instanceInService`; the certificate dispatcher says why); a held pass
// does nothing and leaves every job queued (`held: true`), so a copied, restored,
// corrupt or half-migrated database sends no report until it is in service again.
// An admin's own Send now is not a pass and is not held.
let _mailHeld = null;
function setTeamReportMailHold(fn) { _mailHeld = typeof fn === "function" ? fn : null; }

function runTeamReports({ force = false } = {}) {
  if (_running) return _running;
  // Answered BEFORE the pass starts: returning inside it before its first await
  // would run its `finally` before `_running` is assigned (see the dispatcher).
  if (_mailHeld && _mailHeld()) return Promise.resolve({ jobs: 0, runs: 0, sent: 0, dropped: 0, deferred: 0, retried: 0, held: true });
  _running = (async () => {
    const out = { jobs: 0, runs: 0, sent: 0, dropped: 0, deferred: 0, retried: 0 };
    try {
      const cutoff = force ? "9999-12-31T23:59:59.999Z" : _nowIso();
      const jobs = db.prepare("SELECT * FROM team_report_jobs WHERE due_at <= ? ORDER BY due_at LIMIT 20").all(cutoff);
      for (const job of jobs) {
        if (_stopping) break;
        out.jobs++;
        try { await _processJob(job, out); }
        catch (e) {
          try { log.error({ competition_id: job.competition_id, kind: job.kind, err: e.message }, "team report job failed"); } catch (e2) { swallowed("team-reports:job-log", e2); }
          try { _crashedJob(job); } catch (e2) { swallowed("team-reports:job-crash", e2); }
        }
      }
      if (!_stopping) await _weeklyDigests(out);
    } catch (e) {
      try { log.error({ err: e.message }, "team report pass failed"); } catch (e2) { swallowed("team-reports:pass-log", e2); }
    } finally {
      _running = null;
    }
    return out;
  })();
  return _running;
}

/** Boot: a send cut by a crash is `unknown`, never retried. */
function recoverInterruptedTeamReportSends() {
  try {
    const r = db.prepare("UPDATE team_report_sends SET status='unknown' WHERE status='sending'").run();
    if (r.changes) log.warn({ count: r.changes }, "team reports: sends interrupted by the last shutdown are marked unknown (not retried)");
    return r.changes;
  } catch (e) { swallowed("team-reports:recover-interrupted", e, { level: "warn" }); return 0; }
}

function startTeamReports() {
  _stopping = false;
  recoverInterruptedTeamReportSends();
  if (process.env.NODE_ENV === "test" || _interval) return;
  _interval = setInterval(() => { runTeamReports().catch((e) => swallowed("team-reports:tick", e, { level: "warn" })); }, TICK_MS);
  _interval.unref();
}
function stopTeamReports() {
  _stopping = true;
  if (_interval) { clearInterval(_interval); _interval = null; }
}

function pendingTeamReports(compId) {
  return db.prepare("SELECT kind, end_key, due_at, passes, last_error FROM team_report_jobs WHERE competition_id=? ORDER BY due_at").all(compId);
}

/** Is a Send now for this event still going out? */
function manualRunInFlight(compId) { return _manual.has(compId); }

/**
 * Send now: one manual run for an event, answered within SEND_NOW_DEADLINE_MS.
 * Resolves to the run's result, or `{ deferred: true }` when the deadline came
 * first (the run carries on; `teamReportsBusy` holds the shutdown drain for it,
 * and its result is the `team_report_sent` event on the event's History).
 * A run that FAILS part-way resolves to `error: true` with what its ledger says
 * went out, and is recorded on the History all the same (with
 * `error: "internal_error"`), whether or not the answer has already gone.
 */
async function runManualReport(compId, opts = {}) {
  if (_manual.has(compId)) return { running: true };
  const endKey = _nowIso();
  const run = runReport(compId, "manual", endKey, opts)
    .catch((e) => {
      try { log.error({ competition_id: compId, err: e.message }, "team report send now failed"); } catch (e2) { swallowed("team-reports:manual-log", e2); }
      const n = { sent: 0, failed: 0, refused: 0 };
      try {
        for (const r of db.prepare("SELECT status, COUNT(*) AS c FROM team_report_sends WHERE competition_id=? AND kind='manual' AND end_key=? GROUP BY status").all(compId, endKey)) {
          if (r.status === "sent" || r.status === "refused") n[r.status] += r.c; else n.failed += r.c;
        }
      } catch (e3) { swallowed("team-reports:manual-ledger", e3); }
      // runReport records its run only when it finishes: a failed one is
      // recorded here, so the History holds every Send now.
      try {
        const { recordCompetitionEvent } = require("./audit");
        if (db.prepare("SELECT 1 FROM competitions WHERE id=?").get(compId)) {
          recordCompetitionEvent(compId, "team_report_sent", opts.actor || "system", {
            kind: "manual", end_key: endKey, ...n, error: "internal_error", ...(opts.context || {}),
          });
        }
      } catch (e4) { swallowed("team-reports:manual-failure-audit", e4); }
      return { ...n, skipped: 0, messages: n.sent + n.failed + n.refused, leads: 0, error: true };
    })
    .finally(() => { _manual.delete(compId); });
  _manual.set(compId, run);
  let timer = null;
  const deadline = new Promise((resolve) => { timer = setTimeout(() => resolve(null), SEND_NOW_DEADLINE_MS); });
  try {
    const out = await Promise.race([run, deadline]);
    return out || { deferred: true };
  } finally { clearTimeout(timer); }
}
// The ledger as the Team section reads it: a removed member's rows say
// "removed member (<domain>)", never the fingerprint form they are stored in.
function recentTeamReportSends(compId) {
  return db.prepare("SELECT kind, end_key, recipient, persona, status, created_at, sent_at FROM team_report_sends WHERE competition_id=? ORDER BY created_at DESC LIMIT 100")
    .all(compId).map(r => ({ ...r, recipient: recipientLabel(r.recipient) }));
}

module.exports = {
  SETTLE_MS, NUDGE_AFTER_MS, MAX_PASSES, RETRY_BACKOFF_MS, SEND_NOW_DEADLINE_MS, PEER_CACHE_MS,
  enqueueTeamReport, runTeamReports, teamReportsBusy, runReport, runManualReport, manualRunInFlight, composeRun, crmCsv, peerAverage, managerPeerScope, previewHtml,
  startTeamReports, stopTeamReports, recoverInterruptedTeamReportSends, setTeamReportMailHold,
  pendingTeamReports, recentTeamReportSends,
  forgetRemovedRecipient, restoreRemovedRecipient,
};
