"use strict";

// Misc superadmin routes that don't belong to a single entity module: the
// default CxOne credential (get / set / clear), the operator SMTP test-email
// diagnostic, the unsubscribed-list view + re-subscribe, (v8.12.7) the
// Checkmarx One account-removal list with its Retry / Mark removed actions, and
// the address the server sees the calling admin at (Use my current address).
// (v7.0.0 refactor: route split — extracted verbatim from server.js.)

const db = require("../db");
const { requireAdmin, requireSuperAdmin, csrfProtection, rateLimit, destructiveAdminLimit } = require("../lib/middleware");
const { getAdminIdentity, recordOrphanedAuditEvent, recordSettingsEvent, recordUserEvent, reqContext, runTxnWithMirrorBuffer } = require("../lib/audit");
const { swallowed } = require("../lib/best-effort");
const fs = require("fs");
const { PLATFORM_VERSION, SERVER_STARTED_AT, DATA_DIR, UPLOADS_DIR } = require("../lib/config");
const { decodeCxOneApiKey } = require("../lib/cxone");
const { transporter, resolveSender, smtpHealthy, withSmtpSlot } = require("../lib/email");
const { getPlatformName } = require("../lib/settings");
const { normaliseEmail, canonicaliseIp, ipAddressRange } = require("../lib/util");
const { listOpenAlerts, ackAlert } = require("../lib/admin-alerts"); // v7.16.0 — operator alerts
const { sweepExpiredEvents, lastPurge, EVENT_RETENTION_DAYS, EVENT_RETENTION_MS, PURGE_MAX_PER_RUN, EVENT_TABLES } = require("../lib/event-retention");
const { listCxOneWithdrawals, cxOneWithdrawalCounts, cxOneWithdrawalPastRetentionCount, cxOneWithdrawalAttentionCount, retryCxOneWithdrawal, dismissCxOneWithdrawal } = require("../lib/cxone-withdraw"); // v8.12.7
const { actingAdminId, competitionDenied, competitorIds } = require("../lib/event-admin");
const { competitorEditDenied } = require("../lib/staff-compete");
const { actorPermissions } = require("../lib/rbac");
const { validateBody } = require("../lib/validate");
const { findUserByAddress } = require("../lib/account-lookup");

// CAN THIS READER TAKE THE ALERT'S ADVICE? The copy tells the reader to put the
// address in the event's "Trusted network IPs" and save, which is the event PUT:
// `events.edit`, the event inside their scope, and not competing in it. A reader
// that PUT would refuse is told to ask someone who can instead (lib/admin-alerts.js
// `alertCopy`, mirrored by the modal) — never sent to a refusal while the venue is
// locked out. Asked per alert, per reader, on every poll.
function _canSetTrustedIps(req, perms, compId) {
  if (!perms.has("events.edit")) return false;
  if (competitionDenied(req, compId)) return false;
  return !competitorEditDenied(db, competitorIds(req), compId);
}

// v8.12.7 — its own bucket, not the destructive-admin one: a superadmin working
// through a list of held removals must not spend the budget a participant
// deletion or an import needs. Registered AFTER the guards (v8.3.11 F3), so an
// anonymous 401 never spends it.
const cxoneWithdrawalLimit = rateLimit(60_000, 30, "cxone-withdrawal");
// The id rides the BODY, never the path, so a realm account id never reaches
// the access log (`_scrubLogPath` would otherwise need a rule for it).
const CXONE_WITHDRAWAL_ACTION_SCHEMA = {
  cxone_user_id: { type: "string", max: 64, required: true },
  override: { type: "bool" },
  // v8.13.1 — the hold the superadmin read before pressing Remove anyway. Required
  // with `override`; refused 409 `cxone_withdrawal_hold_changed` when the row is
  // no longer held for it (lib/cxone-withdraw.js retryCxOneWithdrawal).
  expected_hold: { type: "string", max: 64 },
  // …and the sign it read (`held_signal`, absent when the row showed none),
  // refused the same way when the row is held for another one.
  expected_signal: { type: "string", max: 64 },
};

module.exports = function register(app, deps = {}) {
// The instance-health gate (server.js `_instanceInService`), handed to the manual
// retention purge so its image sweep holds exactly as the daily pass's does.
const { isHealthy, healthState } = deps;
// v7.7.17 — event-data retention. GET surfaces the configured window + the last
// purge summary (in-process, resets on restart until the boot sweep runs) so an
// operator can confirm the policy is active. The daily background purge runs
// automatically (lib/event-retention.js); this read-only view is any-admin.
// ── v7.16.0 — operator alerts (IP bans during a live competition) ───────────
// Polled by the admin SPA. See lib/admin-alerts.js for the delivery model and
// why acknowledgement has two tiers.
app.get("/api/admin/alerts", requireAdmin, (req, res) => {
  const who = getAdminIdentity(req);
  // v7.29.0 — smtp_healthy rides THIS poll rather than getting one of its own.
  // It is an operational condition an admin must see, which is exactly what this
  // channel already is, and folding it in costs zero extra requests per tick.
  //
  // The probe has run every five minutes since it was written and was exposed
  // ONLY as a Prometheus gauge, so no operator without a metrics stack could ever
  // see it — a signal with no human consumer (the v7.21.2 class). It matters most
  // at a walk-up desk, where a greylisted first contact and a broken platform look
  // identical from the far side of the table.
  //
  // null means "not probed yet" and the client must NOT render it as a failure.
  //
  // v8.12.7 — and, for a superadmin only, how many Checkmarx One account
  // removals need a human (held, needing attention, given up, or never marked).
  // Same argument: the removal runner retries on its own, so only a number that
  // needs a decision is worth a banner, and the only tier that can act on it is
  // the one shown it. Absent — never 0 — for everyone else.
  const perms = actorPermissions(req).perms;
  const alerts = listOpenAlerts(who).map(a => (a.competition_id ? { ...a, can_set_trusted_ips: _canSetTrustedIps(req, perms, a.competition_id) } : a));
  res.json({
    alerts, isSuperAdmin: !!req.session.isSuperAdmin, smtp_healthy: smtpHealthy(),
    ...(req.session.isSuperAdmin ? { cxone_withdrawals_attention: cxOneWithdrawalAttentionCount() } : {}),
  });
});

// ── v8.12.7 — Checkmarx One accounts the platform created for people it has
// since deleted (lib/cxone-ledger.js + lib/cxone-withdraw.js). SUPERADMIN-only,
// because removing an account from a customer's tenant is a decision about the
// customer's system, not about one event. The runner does the removal on its
// own; these routes are for the rows it cannot finish without a human.
// `cxone_in_use` lets the settings card stay hidden on a deployment that has
// never configured Checkmarx One and holds no ledger rows.
function _cxoneInUse() {
  return !!(db.prepare("SELECT 1 FROM competitions WHERE cxone_api_key IS NOT NULL AND cxone_api_key <> '' LIMIT 1").get()
    || db.prepare("SELECT 1 FROM settings WHERE key='default_cxone_api_key' AND value IS NOT NULL AND value <> '' LIMIT 1").get()
    || db.prepare("SELECT 1 FROM cxone_realm_accounts LIMIT 1").get());
}

// ONE clock and ONE read per response: the counts are taken from the rows
// listed, so a row crossing the retention cutoff mid-response cannot be flagged
// in one and not the other. `past_retention_count` sits OUTSIDE `counts`, the
// per-state partition (its keys sum to `total`); no row is ever dropped for its
// age, and `retention_days` lets the card say which window it was kept past.
app.get("/api/admin/cxone/withdrawals", requireAdmin, requireSuperAdmin, (req, res) => {
  const rows = listCxOneWithdrawals({ nowIso: new Date().toISOString() });
  res.json({ rows, counts: cxOneWithdrawalCounts({ rows }), past_retention_count: cxOneWithdrawalPastRetentionCount({ rows }),
    retention_days: EVENT_RETENTION_DAYS, cxone_in_use: _cxoneInUse() });
});

// `past_retention` only when true (never a null or false key): the line then
// records that a superadmin resolved a removal kept past the retention window.
function _cxoneWithdrawalAuditDetails(row, extra) {
  return {
    cxone_user_id: row.cxone_user_id,
    realm: { iam_origin: row.iam_origin || null, tenant: row.tenant || null },
    ...(row.past_retention === true ? { past_retention: true } : {}),
    ...extra,
  };
}

app.post("/api/admin/cxone/withdrawals/retry", requireAdmin, requireSuperAdmin, cxoneWithdrawalLimit, csrfProtection, (req, res) => {
  const _v = validateBody(req.body, CXONE_WITHDRAWAL_ACTION_SCHEMA);
  if (_v.error) return res.status(400).json({ error: _v.error });
  const { cxone_user_id: id, override, expected_hold: expectedHold, expected_signal: expectedSignal } = _v.values;
  // The HAND, not the seat: an override is a human decision, recorded as theirs
  // (v8.12.1's attribution rule — `actorId` would name an impersonated seat).
  const r = retryCxOneWithdrawal(id, { override: !!override, expectedHold, expectedSignal, actorId: actingAdminId(req) || "superadmin" });
  if (!r.ok) return res.status(r.status || 400).json({ error: r.error, code: r.code, ...(r.row ? { row: r.row } : {}) });
  const row = r.row || { cxone_user_id: id };
  recordOrphanedAuditEvent("user", row.user_id || null, "cxone_realm_withdrawal_retried", getAdminIdentity(req),
    _cxoneWithdrawalAuditDetails(row, {
      ...(r.overridden ? { override_reason: r.overridden } : {}),
      ...reqContext(req),
    }));
  res.json({ ok: true, row: r.row });
});

app.post("/api/admin/cxone/withdrawals/dismiss", requireAdmin, requireSuperAdmin, cxoneWithdrawalLimit, csrfProtection, (req, res) => {
  const _v = validateBody(req.body, CXONE_WITHDRAWAL_ACTION_SCHEMA);
  if (_v.error) return res.status(400).json({ error: _v.error });
  const r = dismissCxOneWithdrawal(_v.values.cxone_user_id);
  if (!r.ok) return res.status(r.status || 400).json({ error: r.error, code: r.code });
  recordOrphanedAuditEvent("user", r.row.user_id || null, "cxone_realm_withdrawal_dismissed", getAdminIdentity(req),
    _cxoneWithdrawalAuditDetails(r.row, { ...reqContext(req) }));
  res.json({ ok: true });
});

app.post("/api/admin/alerts/:id/ack", requireAdmin, csrfProtection, (req, res) => {
  // "global" silences the alert for EVERY admin and suppresses further alerts
  // for that address — a judgement that the traffic is a real scanner rather
  // than the venue. Getting that wrong hides a room-wide outage from the people
  // who could fix it, so it is superadmin-only; a regular admin's dismissal
  // only clears their own view.
  const wantGlobal = req.body && (req.body.scope === "global");
  if (wantGlobal && !req.session.isSuperAdmin) {
    return res.status(403).json({ error: "Only a superadmin can dismiss this alert for everyone." });
  }
  const who = getAdminIdentity(req);
  const ok = ackAlert(req.params.id, who, wantGlobal ? "global" : "self");
  if (!ok) return res.status(404).json({ error: "Alert not found" });
  if (wantGlobal) {
    try {
      recordOrphanedAuditEvent("security", req.params.id, "ip_ban_alert_dismissed", who, {
        ...reqContext(req),
        scope: "global", ...reqContext(req),
      });
    } catch (e) { swallowed("admin-misc:alert-dismiss-audit", e); }
  }
  res.json({ ok: true, scope: wantGlobal ? "global" : "self" });
});

// THE ADDRESS THE SERVER SEES THIS ADMIN AT, for "Use my current address" beside
// an event's Trusted network IPs. An organiser on the venue's network reaches the
// platform from the venue's egress address, which is exactly what that field
// wants, and nothing else in the app says what it is until a block raises an
// alert. The gate asks `events.edit` (lib/rbac.js), the permission of the event
// PUT that writes the field; the guard is `requireAdmin` rather than
// requirePermission, which refuses every request made through an organiser's
// impersonated seat, where the event form and its Save stay open. The answer is
// the requester's own address, canonical as the field stores it, with its range
// (lib/util.js ipAddressRange): the form adds only a `public` one. `no-store`:
// the answer describes this request's network path, not a stored resource.
app.get("/api/admin/my-address", requireAdmin, (req, res) => {
  const ip = canonicaliseIp(req.ip) || null;
  res.set("Cache-Control", "no-store");
  res.json({ ip, range: ip ? ipAddressRange(ip) : "unknown" });
});

app.get("/api/admin/retention", requireAdmin, (req, res) => {
  res.json({
    retention_days: EVENT_RETENTION_DAYS,
    retention_ms: EVENT_RETENTION_MS,
    purge_max_per_run: PURGE_MAX_PER_RUN,
    tables: EVENT_TABLES.map(t => t.table),
    last_purge: lastPurge(),
  });
});

// SETTINGS → BACKUPS & HEALTH. Coarse facts only (booleans, whole numbers,
// rounded sizes, the version), never a path, a driver message or a secret: the
// boot integrity and schema checks and maintenance mode come from server.js's
// own state (`healthState`, the facts `_instanceInService` reads), never
// re-derived here. A superadmin also gets the database's size, the Node version
// and the process start time; every other reader gets the redacted shape, those
// keys absent. `settings.view` at the gate (lib/rbac.js).
const _GIB = 1024 * 1024 * 1024;
function _freeGib(dir) {
  try {
    if (!dir || !fs.statfsSync) return null;
    const s = fs.statfsSync(dir);
    return Math.round((s.bavail * s.bsize / _GIB) * 10) / 10;
  } catch (e) { swallowed("admin-misc:statfs", e); return null; }
}
app.get("/api/admin/system-health", requireAdmin, (req, res) => {
  const h = typeof healthState === "function" ? healthState() : {};
  const smtp = smtpHealthy();
  const body = {
    version: PLATFORM_VERSION,
    database_integrity_ok: h.integrity === true,
    database_schema_ok: h.schema === true,
    maintenance: h.maintenance === true,
    smtp_healthy: smtp === true ? true : smtp === false ? false : null,
    uptime_seconds: Math.floor(process.uptime()),
    data_free_gib: _freeGib(DATA_DIR),
    uploads_free_gib: _freeGib(UPLOADS_DIR),
    event_retention_days: EVENT_RETENTION_DAYS,
  };
  if (req.session.isSuperAdmin) {
    let size = null;
    // The main file plus its write-ahead log, which holds every commit since the
    // last checkpoint (the -shm index is a few KiB and left out).
    try {
      let bytes = fs.statSync(db.name).size;
      try { bytes += fs.statSync(`${db.name}-wal`).size; }
      catch (e) { if (e.code !== "ENOENT") throw e; }
      size = Math.round(bytes / (1024 * 1024) * 10) / 10;
    } catch (e) { swallowed("admin-misc:db-size", e); }
    body.database_size_mib = size;
    body.node_version = process.version;
    body.started_at = SERVER_STARTED_AT;
  }
  res.set("Cache-Control", "no-store");
  res.json(body);
});

// Superadmin-only manual purge — runs one sweep immediately (the same engine the
// daily reaper uses), attributed to the acting superadmin. CSRF + destructive
// rate limit. Returns the purge summary (per-table counts + total).
app.post("/api/admin/retention/purge", requireAdmin, requireSuperAdmin, destructiveAdminLimit, csrfProtection, (req, res) => {
  const summary = sweepExpiredEvents({ actor: getAdminIdentity(req), reqContext: reqContext(req), isHealthy });
  res.json({ ok: true, ...summary });
});

app.get("/api/admin/default-cxone", requireAdmin, requireSuperAdmin, (req, res) => {
  const apiKey = db.prepare("SELECT value FROM settings WHERE key='default_cxone_api_key'").get()?.value || "";
  const cfg = decodeCxOneApiKey(apiKey);
  const groupName = db.prepare("SELECT value FROM settings WHERE key='default_cxone_group_name'").get()?.value || "";
  res.json({
    cxone_configured: !!cfg,
    cxone_tenant: cfg?.tenant || "",
    cxone_base_url: cfg?.baseUrl || "",
    cxone_group_name: groupName,
  });
});

app.put("/api/admin/default-cxone", requireAdmin, requireSuperAdmin, csrfProtection, (req, res) => {
  const { cxone_api_key, cxone_group_name } = req.body;
  // ext-audit batch 4 — typeof guards before the .trim() calls inside the txn
  // (a non-string api key / group name would 500).
  if (cxone_api_key != null && typeof cxone_api_key !== "string")
    return res.status(400).json({ error: "API key must be text" });
  if (cxone_group_name != null && typeof cxone_group_name !== "string")
    return res.status(400).json({ error: "Group name must be text" });
  const upsert = db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)");
  const adminId = getAdminIdentity(req);
  const defaultCxoneTxn = db.transaction(() => {
    const changes = {};
    if (cxone_api_key && cxone_api_key.trim()) {
      const decoded = decodeCxOneApiKey(cxone_api_key.trim());
      if (!decoded) throw { userError: true, error: "The API key you entered is not a valid CheckmarxOne API key. Please verify the key and try again. The previous key (if any) has been retained." };
      upsert.run("default_cxone_api_key", cxone_api_key.trim());
      changes.api_key = "updated";
    }
    if (cxone_group_name != null) {
      upsert.run("default_cxone_group_name", cxone_group_name.trim());
      changes.group_name = cxone_group_name.trim();
    }
    if (Object.keys(changes).length) recordSettingsEvent("default_cxone", "updated", adminId, { ...changes, ...reqContext(req) });
  });
  try { runTxnWithMirrorBuffer(() => defaultCxoneTxn()); } catch (e) { if (e.userError) return res.status(400).json({ error: e.error }); throw e; }
  const apiKey = db.prepare("SELECT value FROM settings WHERE key='default_cxone_api_key'").get()?.value || "";
  const cfg = decodeCxOneApiKey(apiKey);
  const grp = db.prepare("SELECT value FROM settings WHERE key='default_cxone_group_name'").get()?.value || "";
  res.json({ ok: true, cxone_configured: !!cfg, cxone_tenant: cfg?.tenant || "", cxone_base_url: cfg?.baseUrl || "", cxone_group_name: grp });
});

app.delete("/api/admin/default-cxone", requireAdmin, requireSuperAdmin, csrfProtection, (req, res) => {
  const adminId = getAdminIdentity(req);
  const clearDefaultTxn = db.transaction(() => {
    db.prepare("DELETE FROM settings WHERE key IN ('default_cxone_api_key','default_cxone_group_name')").run();
    recordSettingsEvent("default_cxone", "cleared", adminId, { ...reqContext(req) });
  });
  runTxnWithMirrorBuffer(() => clearDefaultTxn());
  res.json({ ok: true, cxone_configured: false, cxone_group_name: "" });
});

app.post("/api/admin/test-email", requireSuperAdmin, csrfProtection, async (req, res) => {
  const to = typeof req.body?.to === "string" ? req.body.to.trim() : "";
  if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
    return res.status(400).json({ error: "Valid recipient 'to' required" });
  }
  // v6.16.39 — audit attribution. An operator-triggered SMTP send to
  // an arbitrary address is a state mutation visible OUTSIDE the
  // platform (the message lands in someone's inbox); pre-fix it left
  // no forensic trail at all. Emit one row for the success case and
  // one for the failure case so an operator can correlate the
  // outcome — both share `event_type=test_email_sent`, distinguished
  // by `details.ok`.
  const adminId = getAdminIdentity(req);
  const ctx = reqContext(req);
  try {
    // A relay connection like every send (lib/email.js withSmtpSlot), so the
    // diagnostic waits its turn rather than queueing inside the pool.
    await withSmtpSlot(() => transporter.sendMail({
      to,
      // v7.26.0 — the SHARED resolver, not a second copy of the ladder. This
      // endpoint exists to tell an operator what real mail looks like, so a
      // diagnostic that reports a different sender from every other send is
      // worse than no diagnostic.
      from: resolveSender(),
      subject: `${getPlatformName()} — SMTP test`,
      text: `This is a test message from ${getPlatformName()} v${PLATFORM_VERSION}. Sent at ${new Date().toISOString()} by an operator via the admin test-email endpoint. If you received this, outbound email is working.`,
    }));
    try {
      recordOrphanedAuditEvent("email", to, "test_email_sent", adminId, { ok: true, ...ctx });
    } catch (e) { swallowed("admin-misc:test-email-audit", e); }
    res.json({ ok: true });
  } catch (e) {
    const errMsg = (e.message || String(e)).slice(0, 300);
    try {
      recordOrphanedAuditEvent("email", to, "test_email_sent", adminId, { ok: false, error: errMsg, ...ctx });
    } catch (auditErr) { swallowed("admin-misc:test-email-failure-audit", auditErr); }
    res.status(502).json({ ok: false, error: errMsg });
  }
});

// v6.16.31 — admin visibility into the unsubscribed list. Surfaces
// who opted out, when, and via which surface so support can re-
// subscribe (`DELETE /api/admin/unsubscribed/:email`) when the
// recipient asks. Both routes are admin-only — these rows reveal
// addresses-of-interest and the audit trail of who unsubscribed.
app.get("/api/admin/unsubscribed", requireAdmin, requireSuperAdmin, (req, res) => {
  // v7.16.7 — `total` used to be `rows.length`, i.e. the count AFTER the LIMIT.
  // Past 1000 unsubscribes the UI therefore showed 1000 rows and reported the
  // total as 1000, with nothing to say anything was missing — an admin checking
  // whether an address had unsubscribed could scan the list, not find it, and
  // conclude it had not. A truncated list that does not admit to being
  // truncated gives a WRONG answer, not merely an incomplete one.
  const LIMIT = 1000;
  const total = db.prepare("SELECT COUNT(*) n FROM unsubscribed_emails").get().n;
  const rows = db.prepare(
    "SELECT email, unsubscribed_at, reason, user_agent, ip FROM unsubscribed_emails ORDER BY unsubscribed_at DESC LIMIT ?"
  ).all(LIMIT);
  res.json({ entries: rows, total, shown: rows.length, truncated: total > rows.length, limit: LIMIT });
});

app.delete("/api/admin/unsubscribed/:email", requireAdmin, requireSuperAdmin, csrfProtection, (req, res) => {
  const email = normaliseEmail(req.params.email);
  if (!email) return res.status(400).json({ error: "Invalid email" });
  const r = db.prepare("DELETE FROM unsubscribed_emails WHERE email=?").run(email);
  if (r.changes === 0) return res.status(404).json({ error: "Email is not in the unsubscribed list" });
  // Audit row tying the resubscribe to the admin who performed it.
  try {
    const adminId = getAdminIdentity(req);
    const user = findUserByAddress(db, email, "id");
    const ctx = reqContext(req);
    if (user) {
      recordUserEvent(user.id, "email_resubscribed", adminId, { ...ctx, email });
    } else {
      recordOrphanedAuditEvent("email", email, "resubscribed", adminId, { ...ctx });
    }
  } catch (e) { swallowed("admin-misc:resubscribe-audit", e); }
  res.json({ ok: true, email });
});
};
