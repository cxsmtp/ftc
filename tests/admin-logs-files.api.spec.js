// @ts-check
//
// v8.13.3 (raw-error-echo) — GET /api/admin/logs/files lists what it can and
// says nothing about the server's filesystem.
//
// The handler stat'ed every log file inside ONE try, so a single entry that
// vanished between readdir and stat — the hourly purge, a rotation, an operator's
// `rm` — or a dangling symlink failed the WHOLE listing, and the 500 carried
// `detail: e.message`: Node's ENOENT message, which names the absolute path of
// the data directory. Two defects: the listing is all-or-nothing over a race the
// server itself causes, and a raw driver/OS error reached the response.
//
// Now each entry is stat'ed on its own; one that cannot be is skipped and logged
// server-side (warn, with the file name and the error code), and the response
// carries no `detail` at all.
const { test, expect } = require("./isolated-test");
const { TEST_DATA_DIR, apiLogin, findLogLine } = require("./helpers");
const fs = require("fs");
const path = require("path");

const LOGS = path.join(TEST_DATA_DIR, "logs");

test("one entry that cannot be stat'ed is skipped, logged, and does not fail the listing", async () => {
  const tag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  // `0000` sorts these below every dated log file, so nothing that reads the
  // newest access/app file (findLogLine, the Logs pane) ever opens them.
  const dangling = `access-0000-dangling-${tag}.jsonl`;
  const real = `access-0000-real-${tag}.jsonl`;
  const danglingPath = path.join(LOGS, dangling);
  const realPath = path.join(LOGS, real);
  const { api } = await apiLogin("superadmin");
  try {
    fs.writeFileSync(realPath, '{"msg":"real"}\n');
    // A symlink to nothing: readdir lists it, stat throws ENOENT — the same
    // shape as a file deleted between the two calls, made deterministic.
    fs.symlinkSync(path.join(LOGS, `missing-target-${tag}`), danglingPath);
    expect(() => fs.statSync(danglingPath), "precondition: the entry really cannot be stat'ed").toThrow();

    const r = await api.get("/api/admin/logs/files");
    const text = await r.text();
    expect(r.status(), text).toBe(200);
    const { files } = JSON.parse(text);
    const names = files.map(f => f.name);
    expect(names, "the readable sibling is still listed").toContain(real);
    expect(names, "the unreadable entry is left out").not.toContain(dangling);
    const realRow = files.find(f => f.name === real);
    expect(typeof realRow.size_bytes).toBe("number");
    expect(realRow.size_bytes).toBeGreaterThan(0);
    // Newest first, as the pane expects.
    const stamps = files.map(f => f.modified_at);
    expect([...stamps].sort().reverse()).toEqual(stamps);
    // Nothing about the server's filesystem reaches the response.
    expect(text.includes(TEST_DATA_DIR), "the data directory's path is not in the response").toBe(false);
    expect(text.includes("ENOENT")).toBe(false);

    // The operator still learns about it, server-side.
    const line = await findLogLine(path.join(TEST_DATA_DIR, "logs"),
      (j) => j.msg === "logs/files: skipped an entry that could not be stat'ed" && j.file === dangling,
      { what: "the warn line naming the skipped entry" });
    expect(line.level).toBe("warn");
    expect(line.code).toBe("ENOENT");
  } finally {
    try { fs.unlinkSync(danglingPath); } catch (_) { /* already gone */ }
    try { fs.unlinkSync(realPath); } catch (_) { /* already gone */ }
    await api.dispose();
  }
});

test("CONTROL: with nothing unreadable the listing is complete", async () => {
  // The skip must not hide ordinary files: every *.jsonl in the directory that
  // matches the listing's pattern is returned.
  const { api } = await apiLogin("superadmin");
  try {
    const r = await api.get("/api/admin/logs/files");
    expect(r.status()).toBe(200);
    const listed = (await r.json()).files.map(f => f.name).sort();
    const onDisk = fs.readdirSync(LOGS).filter(f => /^(access|app)-.*\.jsonl$/.test(f)).sort();
    expect(listed).toEqual(onDisk);
    expect(listed.length, "the worker has written at least one log file").toBeGreaterThan(0);
  } finally { await api.dispose(); }
});
