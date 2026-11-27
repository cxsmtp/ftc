// Fed to `node -` inside the app container by perf/storm-podman.sh's sampler:
// prints one JSON line with the session-table shape and the WAL size. Opens the
// database READ-ONLY, so it can never write to the database it measures.
const fs = require("fs");
const D = require("/app/node_modules/better-sqlite3");
const dir = process.env.DATA_DIR || "/app/data";
const out = { t: Date.now() };
try { out.walBytes = fs.statSync(`${dir}/hackathon.db-wal`).size; } catch (_) { out.walBytes = null; }
try { out.dbBytes = fs.statSync(`${dir}/hackathon.db`).size; } catch (_) { out.dbBytes = null; }
try {
  const d = new D(`${dir}/hackathon.db`, { readonly: true, fileMustExist: true });
  d.pragma("busy_timeout = 2000");
  const r = d.prepare(`SELECT COUNT(*) AS n, SUM(CASE WHEN data LIKE '%"userId":"%' THEN 1 ELSE 0 END) AS auth FROM express_session`).get();
  out.sessions = r.n; out.authSessions = r.auth || 0;
  d.close();
} catch (e) { out.error = String(e && e.message || e); }
console.log(JSON.stringify(out));
