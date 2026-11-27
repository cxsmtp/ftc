// @ts-check
//
// THE CI RUNNER'S DISK, LOGGED WHILE THE TESTS RUN.
//
// On two cross-browser runs the runner's disk ran out about 2 min 40 s in (52 MB
// and 0 MB free, 16 Nov 2026) and freed itself again; the test running at that
// moment failed and passed on its retry, and nothing in the log said what had
// filled the disk. So every CI run (`tests/global-setup.js`) samples it every
// 5 s and prints a `[disk]` line when free space moves by 250 MB, while it is
// under 1 GiB, and once a minute: free space, the largest directories under the
// temp dir, the repository and HOME, files deleted but still held open (which
// `du` cannot see), and /dev/shm. It never fails the run: each read is bounded,
// and one that fails prints why.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");

const REPO = path.resolve(__dirname, "..");
const MB = 1024 * 1024;

function freeMb(p) {
  try { const s = fs.statfsSync(p); return Math.floor((s.bavail * s.bsize) / MB); } catch (e) { return null; }
}

function shmText() {
  try {
    const s = fs.statfsSync("/dev/shm");
    return `/dev/shm ${Math.round(((s.blocks - s.bfree) * s.bsize) / MB)} of ${Math.round((s.blocks * s.bsize) / MB)} MB`;
  } catch (e) { return `/dev/shm unread (${e.code || e.message})`; }
}

/** `du -x -k -d 1` of one root, bounded; du exits 1 when a file vanishes mid-walk (a browser profile going), and what it printed still stands. */
function duOne(root) {
  return new Promise((resolve) => {
    execFile("du", ["-x", "-k", "-d", "1", root], { timeout: 4000, maxBuffer: 8 * MB }, (err, stdout) => {
      const rows = [];
      for (const line of String(stdout || "").split("\n")) {
        const m = /^(\d+)\t(.+)$/.exec(line);
        if (m && m[2] !== root) rows.push({ mb: Math.round(Number(m[1]) / 1024), what: m[2] });
      }
      resolve({ rows, error: rows.length || !err ? null : `${root}: ${String(err.message).split("\n")[0]}` });
    });
  });
}

/** Every root at once; one that times out costs only its own rows. */
async function du(roots) {
  const each = await Promise.all(roots.map(duOne));
  return { rows: each.flatMap((r) => r.rows), errors: each.map((r) => r.error).filter(Boolean) };
}

/** Files deleted but held open by some process: the disk they use frees only when they are closed. */
function deletedButOpen() {
  const rows = [];
  const seen = new Set();
  let pids = [];
  try { pids = fs.readdirSync("/proc").filter((d) => /^\d+$/.test(d)); } catch (e) { return { rows, error: e.code || e.message }; }
  for (const pid of pids) {
    let fds = [];
    try { fds = fs.readdirSync(`/proc/${pid}/fd`); } catch (e) { fds = []; }
    for (const fd of fds) {
      try {
        const link = fs.readlinkSync(`/proc/${pid}/fd/${fd}`);
        if (!link.endsWith(" (deleted)") || link.startsWith("/memfd:") || link.startsWith("/dev/shm/")) continue;
        const st = fs.statSync(`/proc/${pid}/fd/${fd}`);
        const key = `${st.dev}:${st.ino}`;
        if (!st.isFile() || seen.has(key)) continue;
        seen.add(key);
        let comm = "?";
        try { comm = fs.readFileSync(`/proc/${pid}/comm`, "utf8").trim(); } catch (e) { comm = `pid ${pid}`; }
        rows.push({ mb: (st.blocks * 512) / MB, what: `${comm} ${link.slice(0, -" (deleted)".length)}` });
      } catch (e) {
        continue; // the fd closed, or its process exited, between the listing and the read
      }
    }
  }
  return { rows, error: null };
}

/** The core-dump limit this process runs under and where the kernel sends a dump: shown once, at the start. */
function coreText() {
  try {
    const lim = /Max core file size\s+(\S+)\s+(\S+)/.exec(fs.readFileSync("/proc/self/limits", "utf8"));
    const pattern = fs.readFileSync("/proc/sys/kernel/core_pattern", "utf8").trim();
    return `core dumps: limit ${lim ? `${lim[1]} (hard ${lim[2]})` : "unread"}, sent to ${JSON.stringify(pattern.slice(0, 90))}`;
  } catch (e) { return `core dumps unread (${e.code || e.message})`; }
}

const top = (rows, n, floorMb) => rows.filter((r) => r.mb >= floorMb).sort((a, b) => b.mb - a.mb).slice(0, n).map((r) => `${r.what} ${Math.round(r.mb)} MB`);
const since = (ms) => { const s = Math.round(ms / 1000); return `+${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`; };

function startDiskProbe(opts = {}) {
  const everyMs = opts.everyMs || 5000;
  const heartbeatMs = opts.heartbeatMs || 60000;
  const t0 = Date.now();
  const roots = [...new Set([os.tmpdir(), REPO, process.env.HOME, "/var/tmp"].filter(Boolean).map((p) => {
    try { return fs.realpathSync(p); } catch (e) { return ""; }
  }).filter(Boolean))];
  let last = null;
  let low = null;
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const now = Date.now();
      const free = freeMb("/");
      const repoFree = freeMb(REPO);
      if (free !== null && (!low || free < low.free)) low = { free, at: now - t0 };
      const moved = last && free !== null && last.free !== null ? Math.abs(free - last.free) : Infinity;
      const due = !last || now - last.at >= heartbeatMs || moved >= 250 || (free !== null && free < 1024 && (moved >= 50 || now - last.at >= 15000));
      if (!due) return;
      const first = !last;
      last = { at: now, free };
      const d = await du(roots);
      const open = deletedButOpen();
      const openMb = open.rows.reduce((a, r) => a + r.mb, 0);
      const parts = [
        `free ${free === null ? "unread" : `${free} MB`}${repoFree !== null && repoFree !== free ? ` (repository's filesystem ${repoFree} MB)` : ""}`,
        `largest: ${top(d.rows, 6, 50).join(", ") || "nothing over 50 MB"}${d.errors.length ? ` (du failed: ${d.errors.join("; ")})` : ""}`,
        open.error ? `open files unread (${open.error})` : `deleted but open: ${Math.round(openMb)} MB${openMb >= 50 ? ` (${top(open.rows, 3, 10).join(", ")})` : ""}`,
        shmText(),
        ...(first ? [coreText()] : []),
      ];
      process.stderr.write(`[disk ${since(now - t0)}] ${parts.join("; ")}\n`);
    } catch (e) {
      process.stderr.write(`[disk] the probe failed: ${String(e && e.message).split("\n")[0]}\n`);
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(tick, everyMs);
  timer.unref();
  tick();
  process.on("exit", () => { if (low) process.stderr.write(`[disk] lowest free during the run: ${low.free} MB at ${since(low.at)}\n`); });
  return { roots };
}

module.exports = { startDiskProbe };
