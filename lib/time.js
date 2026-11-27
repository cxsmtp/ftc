"use strict";

const { swallowed } = require("./best-effort");

// Single source of "current time" so every status calculation, scheduler, and
// timestamp agrees. A function (not a constant) so it always reflects the real
// clock at call time.
const now = () => new Date();

// ONE FORMATTER PER ZONE, kept for the life of the process. Building an
// Intl.DateTimeFormat costs about 55 µs of CPU, and the participant import
// validates a zone once per row while bulk mail formats a date once per
// recipient, so a fresh formatter per call spent a third of a second on a
// 5000-row file. `zoneFormatter` is the only reader and writer of the memo:
// isValidTimezone (lib/util.js) asks whether one exists, formatEmailDate uses it.
//
// Keyed by the EXACT string ("  Europe/London" stays refused: Intl refuses the
// padding, and a trimmed key would turn it valid). A zone Intl refuses is
// remembered as `false`, but only on a RangeError ("Invalid time zone
// specified"): zone data is compiled into the Node binary and never reloaded,
// so that answer cannot change while the process runs. Any other error is not
// about the zone and is retried next call (CLAUDE.md "Never cache a failure").
// Bounded: at most ZONE_MEMO_MAX entries, the oldest evicted first, and a key
// longer than ZONE_KEY_MAX (the longest IANA name is 30 characters) is answered
// but never kept, as the timezone column has no length cap. The cap can be
// filled with valid zones too (offset forms and case variants are unbounded in
// number), so its ceiling, about 0.5 MB, is reachable by a caller; eviction
// costs only the per-call construction this replaced.
const EMAIL_DATE_OPTS = Object.freeze({
  day: "2-digit", month: "short", year: "numeric",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
});
const ZONE_MEMO_MAX = 1024;
const ZONE_KEY_MAX = 64;
const _zoneFormatters = new Map();
function zoneFormatter(tz) {
  if (typeof tz !== "string" || !tz) return null;
  const hit = _zoneFormatters.get(tz);
  if (hit !== undefined) return hit || null;
  let fmt;
  try {
    fmt = new Intl.DateTimeFormat("en-GB", { ...EMAIL_DATE_OPTS, timeZone: tz });
  } catch (e) {
    if (!(e instanceof RangeError)) { swallowed("time:zone-formatter", e); return null; }
    // The trace of a stored zone Intl refuses (bulk-seed stores zones
    // unvalidated): written when the refusal is built, so once per remembered zone.
    swallowed("time:zone-refused", e);
    fmt = false;
  }
  if (tz.length <= ZONE_KEY_MAX) {
    if (_zoneFormatters.size >= ZONE_MEMO_MAX) _zoneFormatters.delete(_zoneFormatters.keys().next().value);
    _zoneFormatters.set(tz, fmt);
  }
  return fmt || null;
}
// Test seam: how many zones the memo holds.
function _zoneMemoSize() { return _zoneFormatters.size; }

// Human-readable timestamp for outbound emails. Renders in the recipient's
// timezone when given a valid IANA tz ("01 Apr 2026 09:00:00 (Europe/London)"),
// else falls back to a UTC string. Pure (Intl + Date) — kept in lib/time so
// non-email callers (the reminder poller, group-sync mail builders) don't have
// to require lib/email just for a date format.
function formatEmailDate(d, tz) {
  try {
    // The try still wraps .format(): an Invalid Date throws a RangeError there.
    const fmt = tz ? zoneFormatter(tz) : null;
    // Intl formats as "01 Apr 2026, 09:00:00" — clean up comma
    if (fmt) return fmt.format(d).replace(",", "") + ` (${tz})`;
  } catch (e) { /* unformattable date, fall through to UTC */ swallowed("time:email-date-tz", e); }
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const pad = n => String(n).padStart(2, "0");
  return `${pad(d.getUTCDate())} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} UTC`;
}

// v8.12.6 (sweep) — HOW LONG UNTIL A START REMINDER'S EVENT BEGINS, in words,
// computed at SEND time from the STORED start. The reminder mail said "starts in
// about 1 hour" (subject: "starts in 1 hour") unconditionally, which is true only
// of a reminder set while the start was still an hour or more away. A reminder
// can be set at any upcoming moment — the pending page offers the button while
// the event is an hour out and leaves it clickable as the clock runs, and an
// admin who moves the start earlier moves the pending reminder with it — so its
// `send_at` can already be past when it is written, and the next dispatcher tick
// sends it at once: measured, a reminder for an event ten minutes away arrived
// saying "about 1 hour". The absolute start time printed beside it was right; the
// sentence a participant reads first was not.
//
// The ordinary case keeps its copy WORD FOR WORD: at 55 minutes or more the
// answer is "about 1 hour". That band is not a guess — the dispatcher sends a
// normal reminder at `send_at` = start − 60 min, up to one 30 s tick late plus one
// SMTP round trip per earlier row in its batch, so it lands a little under the
// hour and "about 1 hour" is true there. Below it the minutes are STATED. A start
// already reached answers null: no reminder is mailed once its event or session
// has started (operator ruling, 25 Nov 2026), so the dispatcher settles that row
// unsent (`reminder_skipped`) rather than word a future that has gone. An
// unusable start keeps the original copy — the one answer that was never
// computed from it.
const REMINDER_ABOUT_AN_HOUR_MIN = 55;
function reminderLeadTime(startMs, nowMs) {
  const ms = startMs - nowMs;
  if (!Number.isFinite(ms)) return { subject: "starts in 1 hour", body: "starts in about 1 hour" };
  if (ms <= 0) return null;
  const min = Math.round(ms / 60000);
  if (min >= REMINDER_ABOUT_AN_HOUR_MIN) return { subject: "starts in 1 hour", body: "starts in about 1 hour" };
  if (min <= 1) return { subject: "starts in a minute", body: "starts in about a minute" };
  return { subject: `starts in ${min} minutes`, body: `starts in about ${min} minutes` };
}

module.exports = {
  now, formatEmailDate, reminderLeadTime, REMINDER_ABOUT_AN_HOUR_MIN,
  zoneFormatter, ZONE_MEMO_MAX, ZONE_KEY_MAX, _zoneMemoSize,
};
