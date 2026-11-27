// @ts-check
/**
 * Task attachments — admin upload/rename/delete, staging flow, participant
 * download, version restore (content + name), JSON export/import round-trip.
 */
const { test, expect } = require("./isolated-test");
const { registerPost } = require("./helpers");
const crypto = require("crypto");
const { apiLogin, PARTICIPANT_PASS, awaitUploadRoom } = require("./helpers");

const S = { ready: false };
async function ensureState() {
  if (S.ready) return;
  const { api } = await apiLogin("superadmin");
  const comps = await (await api.get("/api/admin/competitions")).json();
  S.liveComp = comps.find(c => c.name === "Test Live");
  S.upcomingComp = comps.find(c => c.name === "Test Upcoming");
  S.endedComp = comps.find(c => c.name === "Test Ended");
  const tasks = await (await api.get("/api/admin/tasks")).json();
  S.easy1 = tasks.find(t => t.title === "Challenge easy1");
  S.med1 = tasks.find(t => t.title === "Challenge med1");
  await api.dispose();
  S.ready = true;
}
function h(csrf) { return { "x-csrf-token": csrf, "content-type": "application/json" }; }

// ───── zip fixture helpers ──────────────────────────────────────────────────
// Pure-Node builders for minimal (un)encrypted ZIPs. We never need real
// encryption: the server's validator keys off the general-purpose bitflag
// in the central-directory record, so a zip with bit 0 set is classified as
// "encrypted" regardless of its data bytes.

function crc32(buf) {
  const zlib = require("zlib");
  if (typeof zlib.crc32 === "function") return zlib.crc32(buf);
  const table = [];
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[i] = c;
  }
  let crc = 0xFFFFFFFF;
  for (const b of buf) crc = (crc >>> 8) ^ table[(crc ^ b) & 0xFF];
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function buildZip(files, { gpFlag = 0 } = {}) {
  const chunks = [], central = [];
  let offset = 0;
  for (const f of files) {
    const nameBuf = Buffer.from(f.name, "utf8");
    const dataBuf = f.data;
    const crc = crc32(dataBuf);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(10, 4);
    lh.writeUInt16LE(gpFlag, 6);
    lh.writeUInt16LE(0, 8);       // stored
    lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(dataBuf.length, 18);
    lh.writeUInt32LE(dataBuf.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    chunks.push(lh, nameBuf, dataBuf);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4); cd.writeUInt16LE(10, 6);
    cd.writeUInt16LE(gpFlag, 8);
    cd.writeUInt16LE(0, 10); cd.writeUInt16LE(0, 12); cd.writeUInt16LE(0, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(dataBuf.length, 20);
    cd.writeUInt32LE(dataBuf.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30); cd.writeUInt16LE(0, 32); cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36); cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);
    offset += lh.length + nameBuf.length + dataBuf.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...chunks, cdBuf, eocd]);
}

function validZipBuffer(name = "README.txt", body = "hello") {
  return buildZip([{ name, data: Buffer.from(body) }]);
}
// Encrypted zip: classic PKWARE encryption prefixes 12 header bytes before
// the compressed payload. yauzl validates compressedSize === uncompressedSize
// + 12 for stored+encrypted entries, so we construct a buffer that passes
// that size check but still has the GP bit 0 flag set so the server's
// validator reaches the "encrypted" branch.
function encryptedZipBuffer() {
  const nameBuf = Buffer.from("secret.txt", "utf8");
  const plainBody = Buffer.from("xxxx");
  const encHeader = Buffer.alloc(12, 0x00);
  const storedBody = Buffer.concat([encHeader, plainBody]); // 16 bytes on disk
  const crc = crc32(plainBody); // CRC is over the un-encrypted bytes per spec
  const lh = Buffer.alloc(30);
  lh.writeUInt32LE(0x04034b50, 0);
  lh.writeUInt16LE(10, 4);
  lh.writeUInt16LE(0x0001, 6);          // GP bit 0 = encrypted
  lh.writeUInt16LE(0, 8);                // stored
  lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0, 12);
  lh.writeUInt32LE(crc, 14);
  lh.writeUInt32LE(storedBody.length, 18);   // compressed size (16)
  lh.writeUInt32LE(plainBody.length, 22);    // uncompressed size (4)
  lh.writeUInt16LE(nameBuf.length, 26);
  lh.writeUInt16LE(0, 28);
  const cd = Buffer.alloc(46);
  cd.writeUInt32LE(0x02014b50, 0);
  cd.writeUInt16LE(20, 4); cd.writeUInt16LE(10, 6);
  cd.writeUInt16LE(0x0001, 8);          // GP bit 0 = encrypted
  cd.writeUInt16LE(0, 10); cd.writeUInt16LE(0, 12); cd.writeUInt16LE(0, 14);
  cd.writeUInt32LE(crc, 16);
  cd.writeUInt32LE(storedBody.length, 20);
  cd.writeUInt32LE(plainBody.length, 24);
  cd.writeUInt16LE(nameBuf.length, 28);
  cd.writeUInt16LE(0, 30); cd.writeUInt16LE(0, 32); cd.writeUInt16LE(0, 34);
  cd.writeUInt16LE(0, 36); cd.writeUInt32LE(0, 38);
  cd.writeUInt32LE(0, 42);               // offset of local header
  const content = Buffer.concat([lh, nameBuf, storedBody]);
  const cdBuf = Buffer.concat([cd, nameBuf]);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(content.length, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([content, cdBuf, eocd]);
}

async function createTask(api, csrf, overrides = {}) {
  const r = await api.post("/api/admin/tasks", {
    headers: h(csrf),
    data: {
      title: `Attach Test ${Date.now()}-${Math.random().toString(16).slice(2, 6)}`,
      difficulty: "easy", answer_type: "text", correct_answer: "a",
      status: "published", ...overrides,
    },
  });
  expect(r.ok()).toBeTruthy();
  return (await r.json()).id;
}

async function uploadAttachment(api, csrf, taskId, { name = "bundle.zip", displayName, body = "hello", zipBuf } = {}) {
  const buffer = zipBuf || validZipBuffer("README.txt", body);
  const r = await api.post(`/api/admin/tasks/${taskId}/attachments`, {
    headers: { "x-csrf-token": csrf },
    multipart: {
      file: { name, mimeType: "application/zip", buffer },
      ...(displayName ? { display_name: displayName } : {}),
    },
  });
  return r;
}

async function assignTaskToLive(api, csrf, taskId) {
  await api.post(`/api/admin/tasks/${taskId}/competitions`, {
    headers: h(csrf), data: { competitionIds: [S.liveComp.id] },
  });
}

// ═══════════════════════════════════════════════════════════════════════════
test.describe("Admin — task attachments CRUD", () => {
  test("upload valid zip → 200 with metadata", async () => {
    await ensureState();
    const { api, csrf } = await apiLogin("superadmin");
    const tid = await createTask(api, csrf);
    const r = await uploadAttachment(api, csrf, tid, { displayName: "Starter pack" });
    expect(r.ok()).toBeTruthy();
    const body = await r.json();
    expect(body.id).toBeTruthy();
    expect(body.display_name).toBe("Starter pack");
    expect(body.size_bytes).toBeGreaterThan(0);
    await api.dispose();
  });

  test("upload encrypted zip → 400 with /encrypted/i error", async () => {
    await ensureState();
    const { api, csrf } = await apiLogin("superadmin");
    const tid = await createTask(api, csrf);
    const r = await api.post(`/api/admin/tasks/${tid}/attachments`, {
      headers: { "x-csrf-token": csrf },
      multipart: {
        file: { name: "enc.zip", mimeType: "application/zip", buffer: encryptedZipBuffer() },
        display_name: "encrypted",
      },
    });
    expect(r.status()).toBe(400);
    expect((await r.json()).error).toMatch(/encrypted/i);
    await api.dispose();
  });

  test("upload truncated zip → 400 invalid archive", async () => {
    await ensureState();
    const { api, csrf } = await apiLogin("superadmin");
    const tid = await createTask(api, csrf);
    const r = await api.post(`/api/admin/tasks/${tid}/attachments`, {
      headers: { "x-csrf-token": csrf },
      multipart: {
        file: { name: "bad.zip", mimeType: "application/zip", buffer: Buffer.from("not-a-zip") },
      },
    });
    expect(r.status()).toBe(400);
    expect((await r.json()).error).toMatch(/ZIP/);
    await api.dispose();
  });

  test("upload with non-.zip extension rejected at multer filter", async () => {
    await ensureState();
    const { api, csrf } = await apiLogin("superadmin");
    const tid = await createTask(api, csrf);
    const r = await api.post(`/api/admin/tasks/${tid}/attachments`, {
      headers: { "x-csrf-token": csrf },
      multipart: { file: { name: "bundle.rar", mimeType: "application/x-rar", buffer: validZipBuffer() } },
    });
    expect(r.status()).toBe(400);
    await api.dispose();
  });

  test("duplicate display_name → 409 (case-insensitive)", async () => {
    await ensureState();
    const { api, csrf } = await apiLogin("superadmin");
    const tid = await createTask(api, csrf);
    const r1 = await uploadAttachment(api, csrf, tid, { displayName: "Starter" });
    expect(r1.ok()).toBeTruthy();
    const r2 = await uploadAttachment(api, csrf, tid, { displayName: "starter" });
    expect(r2.status()).toBe(409);
    await api.dispose();
  });

  test("max 10 attachments per task → 409 on the 11th", async () => {
    await ensureState();
    const { api, csrf } = await apiLogin("superadmin");
    const tid = await createTask(api, csrf);
    for (let i = 1; i <= 10; i++) {
      const r = await uploadAttachment(api, csrf, tid, { displayName: `bundle-${i}` });
      expect(r.ok()).toBeTruthy();
    }
    const r11 = await uploadAttachment(api, csrf, tid, { displayName: "bundle-11" });
    expect(r11.status()).toBe(409);
    await api.dispose();
  });

  test("admin list returns metadata but not sha256/storage_path", async () => {
    await ensureState();
    const { api, csrf } = await apiLogin("superadmin");
    const tid = await createTask(api, csrf);
    await uploadAttachment(api, csrf, tid, { displayName: "pack" });
    const list = await (await api.get(`/api/admin/tasks/${tid}/attachments`)).json();
    expect(Array.isArray(list)).toBeTruthy();
    expect(list.length).toBe(1);
    expect(list[0]).toHaveProperty("display_name");
    expect(list[0]).toHaveProperty("size_bytes");
    expect(list[0]).not.toHaveProperty("sha256");
    expect(list[0]).not.toHaveProperty("storage_path");
    await api.dispose();
  });

  test("rename updates display_name (v6.13.11: no task_versions snapshot, audit-only)", async () => {
    // Pre-v6.13.11 a PATCH on an attachment created a task_versions
    // row with change_type=attachment_renamed. That was removed in
    // v6.13.11 so in-session attachment tweaks don't clutter the
    // Challenge History dialog; the audit-log event is still emitted
    // for accountability. Contract this test locks: rename mutates
    // display_name, does NOT bump versions — only Save does.
    await ensureState();
    const { api, csrf } = await apiLogin("superadmin");
    const tid = await createTask(api, csrf);
    const versionsBeforeUpload = await (await api.get(`/api/admin/tasks/${tid}/versions`)).json();
    const up = await (await uploadAttachment(api, csrf, tid, { displayName: "Starter" })).json();
    const r = await api.patch(`/api/admin/tasks/${tid}/attachments/${up.id}`, {
      headers: h(csrf), data: { display_name: "Starter Pack v2" },
    });
    expect(r.ok()).toBeTruthy();
    const list = await (await api.get(`/api/admin/tasks/${tid}/attachments`)).json();
    expect(list[0].display_name).toBe("Starter Pack v2");
    const versions = await (await api.get(`/api/admin/tasks/${tid}/versions`)).json();
    expect(versions.length, "attachment upload + rename must NOT create new task_versions rows").toBe(versionsBeforeUpload.length);
    expect(versions.some(v => v.change_type === "attachment_renamed"), "attachment_renamed snapshot is explicitly NOT created post-v6.13.11").toBe(false);
    await api.dispose();
  });

  test("soft delete removes from list (v6.13.11: no task_versions snapshot, audit-only)", async () => {
    // Mirror of the rename test — delete path.
    await ensureState();
    const { api, csrf } = await apiLogin("superadmin");
    const tid = await createTask(api, csrf);
    const versionsBeforeUpload = await (await api.get(`/api/admin/tasks/${tid}/versions`)).json();
    const up = await (await uploadAttachment(api, csrf, tid, { displayName: "Bundle" })).json();
    const r = await api.delete(`/api/admin/tasks/${tid}/attachments/${up.id}`, {
      headers: { "x-csrf-token": csrf },
    });
    expect(r.ok()).toBeTruthy();
    const list = await (await api.get(`/api/admin/tasks/${tid}/attachments`)).json();
    expect(list.length).toBe(0);
    const versions = await (await api.get(`/api/admin/tasks/${tid}/versions`)).json();
    expect(versions.length, "attachment upload + delete must NOT create new task_versions rows").toBe(versionsBeforeUpload.length);
    expect(versions.some(v => v.change_type === "attachment_removed"), "attachment_removed snapshot is explicitly NOT created post-v6.13.11").toBe(false);
    await api.dispose();
  });

  test("locked task rejects upload/rename/delete with 403", async () => {
    await ensureState();
    const { api, csrf } = await apiLogin("superadmin");
    const tid = await createTask(api, csrf);
    const up = await (await uploadAttachment(api, csrf, tid, { displayName: "Pre-lock" })).json();
    // Lock the task
    await api.post(`/api/admin/tasks/${tid}/lock`, { headers: { "x-csrf-token": csrf } });
    // Upload, rename, delete should all 403 now
    const r1 = await uploadAttachment(api, csrf, tid, { displayName: "After lock" });
    expect(r1.status()).toBe(403);
    const r2 = await api.patch(`/api/admin/tasks/${tid}/attachments/${up.id}`, {
      headers: h(csrf), data: { display_name: "Renamed" },
    });
    expect(r2.status()).toBe(403);
    const r3 = await api.delete(`/api/admin/tasks/${tid}/attachments/${up.id}`, {
      headers: { "x-csrf-token": csrf },
    });
    expect(r3.status()).toBe(403);
    await api.dispose();
  });

  test("non-admin caller gets 403 on all task attachment routes", async () => {
    await ensureState();
    const { api: aliceApi, csrf: aliceCsrf } = await apiLogin("alice@acme.com", PARTICIPANT_PASS);
    // use an existing task id (any will do — auth check happens first)
    const tid = S.easy1.id;
    const rList = await aliceApi.get(`/api/admin/tasks/${tid}/attachments`);
    expect(rList.status()).toBe(403);
    const rUp = await aliceApi.post(`/api/admin/tasks/${tid}/attachments`, {
      headers: { "x-csrf-token": aliceCsrf },
      multipart: { file: { name: "a.zip", mimeType: "application/zip", buffer: validZipBuffer() } },
    });
    expect(rUp.status()).toBe(403);
    await aliceApi.dispose();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
test.describe("Participant — attachment downloads", () => {
  test("download streams zip with correct headers + bytes", async () => {
    await ensureState();
    const { api: adminApi, csrf: adminCsrf } = await apiLogin("superadmin");
    const tid = await createTask(adminApi, adminCsrf);
    await assignTaskToLive(adminApi, adminCsrf, tid);
    const zipBuf = validZipBuffer("readme.txt", "payload");
    const up = await (await adminApi.post(`/api/admin/tasks/${tid}/attachments`, {
      headers: { "x-csrf-token": adminCsrf },
      multipart: {
        file: { name: "pack.zip", mimeType: "application/zip", buffer: zipBuf },
        display_name: "Starter Pack",
      },
    })).json();
    await adminApi.dispose();

    const { api: aliceApi, csrf: aliceCsrf } = await apiLogin("alice@acme.com", PARTICIPANT_PASS);
    await aliceApi.post("/api/select-competition", {
      headers: h(aliceCsrf), data: { competitionId: S.liveComp.id },
    });
    const r = await aliceApi.get(`/api/tasks/${tid}/attachments/${up.id}`);
    expect(r.ok()).toBeTruthy();
    expect(r.headers()["content-type"]).toBe("application/zip");
    expect(r.headers()["content-disposition"]).toMatch(/Starter_Pack\.zip/);
    const downloaded = await r.body();
    expect(downloaded.equals(zipBuf)).toBeTruthy();
    await aliceApi.dispose();
  });

  test("GET /api/tasks/:id includes attachments array without sha256", async () => {
    await ensureState();
    const { api: adminApi, csrf: adminCsrf } = await apiLogin("superadmin");
    const tid = await createTask(adminApi, adminCsrf);
    await assignTaskToLive(adminApi, adminCsrf, tid);
    await uploadAttachment(adminApi, adminCsrf, tid, { displayName: "Bundle A" });
    await adminApi.dispose();

    const { api: aliceApi, csrf: aliceCsrf } = await apiLogin("alice@acme.com", PARTICIPANT_PASS);
    await aliceApi.post("/api/select-competition", {
      headers: h(aliceCsrf), data: { competitionId: S.liveComp.id },
    });
    const body = await (await aliceApi.get(`/api/tasks/${tid}`)).json();
    expect(Array.isArray(body.attachments)).toBeTruthy();
    expect(body.attachments[0]).toHaveProperty("display_name");
    expect(body.attachments[0]).toHaveProperty("size_bytes");
    expect(body.attachments[0]).not.toHaveProperty("sha256");
    expect(body.attachments[0]).not.toHaveProperty("storage_path");
    await aliceApi.dispose();
  });

  test("participant not enrolled in the task's competition can't download (v6.13.16: worker-isolation-robust)", async () => {
    // Carol is NOT enrolled in "Test Upcoming" per the seed
    // (tests/helpers.js line ~145 enrols only alice + bob into
    // upcomingComp). Assigning the task to upcomingComp + running
    // this as Carol gives a deterministic 404 regardless of Carol's
    // prior `users.active_competition_id` state (which other files
    // in the same worker's run may or may not have mutated via
    // select-competition). Pre-v6.13.16 the test put the task in
    // liveComp where Carol IS enrolled, so the outcome depended on
    // Carol's session-auto-resume state — flaky under WORKERS=4.
    await ensureState();
    const { api: adminApi, csrf: adminCsrf } = await apiLogin("superadmin");
    const tid = await createTask(adminApi, adminCsrf);
    // Assign to upcomingComp instead of liveComp — Carol isn't enrolled there.
    await adminApi.post(`/api/admin/tasks/${tid}/competitions`, {
      headers: h(adminCsrf), data: { competitionIds: [S.upcomingComp.id] },
    });
    const up = await (await uploadAttachment(adminApi, adminCsrf, tid, { displayName: "pack" })).json();
    await adminApi.dispose();

    const { api: carolApi } = await apiLogin("carol@acme.com", PARTICIPANT_PASS);
    const r = await carolApi.get(`/api/tasks/${tid}/attachments/${up.id}`);
    expect(r.status(), "Carol (not enrolled in the task's comp) must be rejected").not.toBe(200);
    expect(r.status(), "rejection should be a 4xx, not a 5xx").toBeGreaterThanOrEqual(400);
    expect(r.status(), "rejection should be a 4xx, not a 5xx").toBeLessThan(500);
    await carolApi.dispose();
  });

  test("unauthenticated user gets 401 on download", async () => {
    await ensureState();
    const { api: adminApi, csrf: adminCsrf } = await apiLogin("superadmin");
    const tid = await createTask(adminApi, adminCsrf);
    await assignTaskToLive(adminApi, adminCsrf, tid);
    const up = await (await uploadAttachment(adminApi, adminCsrf, tid, { displayName: "pack" })).json();
    await adminApi.dispose();

    const { freshCtx } = require("./helpers");
    const { api } = await freshCtx();
    const r = await api.get(`/api/tasks/${tid}/attachments/${up.id}`);
    expect(r.status()).toBe(401);
    await api.dispose();
  });

  test("soft-detached attachment returns 404 on direct download", async () => {
    await ensureState();
    const { api: adminApi, csrf: adminCsrf } = await apiLogin("superadmin");
    const tid = await createTask(adminApi, adminCsrf);
    await assignTaskToLive(adminApi, adminCsrf, tid);
    const up = await (await uploadAttachment(adminApi, adminCsrf, tid, { displayName: "detachable" })).json();
    await adminApi.delete(`/api/admin/tasks/${tid}/attachments/${up.id}`, { headers: { "x-csrf-token": adminCsrf } });
    await adminApi.dispose();

    const { api: aliceApi, csrf: aliceCsrf } = await apiLogin("alice@acme.com", PARTICIPANT_PASS);
    await aliceApi.post("/api/select-competition", {
      headers: h(aliceCsrf), data: { competitionId: S.liveComp.id },
    });
    const r = await aliceApi.get(`/api/tasks/${tid}/attachments/${up.id}`);
    expect(r.status()).toBe(404);
    await aliceApi.dispose();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
test.describe("Staging flow — create-time attachments", () => {
  test("staging POST returns staging_id + metadata", async () => {
    await ensureState();
    const { api, csrf } = await apiLogin("superadmin");
    const r = await api.post("/api/admin/attachment-staging", {
      headers: { "x-csrf-token": csrf },
      multipart: {
        file: { name: "seed.zip", mimeType: "application/zip", buffer: validZipBuffer() },
        display_name: "Seed Pack",
      },
    });
    expect(r.ok()).toBeTruthy();
    const body = await r.json();
    expect(body.staging_id).toBeTruthy();
    expect(body.display_name).toBe("Seed Pack");
    expect(body.size_bytes).toBeGreaterThan(0);
    await api.dispose();
  });

  test("POST /api/admin/tasks with staging_attachments promotes the file", async () => {
    await ensureState();
    const { api, csrf } = await apiLogin("superadmin");
    const s1 = await (await api.post("/api/admin/attachment-staging", {
      headers: { "x-csrf-token": csrf },
      multipart: {
        file: { name: "a.zip", mimeType: "application/zip", buffer: validZipBuffer("a.txt", "A") },
        display_name: "alpha",
      },
    })).json();
    const s2 = await (await api.post("/api/admin/attachment-staging", {
      headers: { "x-csrf-token": csrf },
      multipart: {
        file: { name: "b.zip", mimeType: "application/zip", buffer: validZipBuffer("b.txt", "BB") },
        display_name: "beta",
      },
    })).json();
    const created = await (await api.post("/api/admin/tasks", {
      headers: h(csrf),
      data: {
        title: `Staging Test ${Date.now()}`,
        difficulty: "easy", answer_type: "text", correct_answer: "a", status: "published",
        staging_attachments: [
          { staging_id: s1.staging_id, display_name: "alpha" },
          { staging_id: s2.staging_id, display_name: "beta" },
        ],
      },
    })).json();
    const list = await (await api.get(`/api/admin/tasks/${created.id}/attachments`)).json();
    expect(list.length).toBe(2);
    expect(list.map(a => a.display_name).sort()).toEqual(["alpha", "beta"]);
    await api.dispose();
  });

  test("staging DELETE discards before promote", async () => {
    await ensureState();
    const { api, csrf } = await apiLogin("superadmin");
    const staged = await (await api.post("/api/admin/attachment-staging", {
      headers: { "x-csrf-token": csrf },
      multipart: { file: { name: "x.zip", mimeType: "application/zip", buffer: validZipBuffer() } },
    })).json();
    const r = await api.delete(`/api/admin/attachment-staging/${staged.staging_id}`, {
      headers: { "x-csrf-token": csrf },
    });
    expect(r.ok()).toBeTruthy();
    // Subsequent DELETE is a 404 — row is gone
    const r2 = await api.delete(`/api/admin/attachment-staging/${staged.staging_id}`, {
      headers: { "x-csrf-token": csrf },
    });
    expect(r2.status()).toBe(404);
    await api.dispose();
  });

  test("staging ownership: admin cannot manipulate another admin's staging", async () => {
    // Seed data has only one superadmin. Simulate a second admin by creating
    // one via the users table is out of scope; instead we probe the 404
    // behaviour with a random staging_id (simulates cross-admin access).
    await ensureState();
    const { api, csrf } = await apiLogin("superadmin");
    const bogusId = crypto.randomUUID();
    const r = await api.patch(`/api/admin/attachment-staging/${bogusId}`, {
      headers: h(csrf), data: { display_name: "nope" },
    });
    expect(r.status()).toBe(404);
    await api.dispose();
  });

  test("staging DELETE cannot destroy another admin's staged upload", async () => {
    // DELETE /api/admin/attachment-staging/:id resolves the row with
    // `WHERE id=? AND admin_id=?` and then fs.unlinkSync()s the ZIP. Strip the
    // ownership half and any admin who learns a staging id destroys a
    // colleague's in-progress upload — the Save that would have promoted it
    // then fails, and the released reservation is credited to the wrong admin.
    //
    // The neighbouring "staging ownership" test cannot see that: it PATCHes a
    // RANDOM id, which 404s whether or not the clause exists. This one drives a
    // REAL second admin against a REAL, existing row and asserts the row + its
    // bytes SURVIVE — a bare 404 is equally satisfied by a row that has just
    // been deleted, so the survival check is the load-bearing assertion.
    await ensureState();
    const Database = require("better-sqlite3");
    const { TEST_DB_PATH } = require("./helpers");
    const readOnlyDb = (fn) => {
      const db = new Database(TEST_DB_PATH, { readonly: true });
      try { return fn(db); } finally { db.close(); }
    };
    const stagingRow = (id) => readOnlyDb(db => db.prepare(
      "SELECT id, admin_id, storage_path FROM task_attachments_staging WHERE id=?"
    ).get(id));

    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf };
    const saJsonH = { ...saH, "content-type": "application/json" };
    const suffix = crypto.randomBytes(4).toString("hex");
    const otherEmail = `stgowner-${suffix}@acme.test`;
    const otherPass = "stagingOwner123!";
    let otherId = null, otherApi = null, stagingId = null;
    try {
      // The victim row — staged by the built-in superadmin, whose
      // getAdminIdentity() is the literal "superadmin".
      const staged = await (await sa.post("/api/admin/attachment-staging", {
        headers: saH,
        multipart: {
          file: { name: "victim.zip", mimeType: "application/zip", buffer: validZipBuffer("v.txt", "victim") },
          display_name: `Victim ${suffix}`,
        },
      })).json();
      stagingId = staged.staging_id;
      expect(stagingId, "staging upload returned an id").toBeTruthy();

      // POSITIVE CONTROL — the row AND its bytes exist before the cross-admin
      // attempt, so "still there afterwards" is evidence of a refusal rather
      // than of nothing having been there.
      const before = stagingRow(stagingId);
      expect(before, "the staged row exists before the cross-admin DELETE").toBeTruthy();
      expect(before.admin_id, "the row is owned by the acting superadmin").toBe("superadmin");
      const stagedFile = pathNode.join(TEST_DATA_DIR, String(before.storage_path));
      expect(fsNode.existsSync(stagedFile), "the staged ZIP is on disk beforehand").toBe(true);

      // A genuinely different admin account (register → verify → approve → promote).
      const regR = await registerPost(sa, "/api/register", {
        headers: saJsonH,
        data: {
          firstName: "Staging", lastName: "Owner", nickname: `stgown_${suffix}`,
          email: otherEmail, password: otherPass, company: "Acme", title: "Engineer",
          avatar: "default1", country: "US", timezone: "America/New_York",
          jobFunction: "Software Developer / Engineer", city: "New York",
        },
      });
      expect(regR.ok(), `register throwaway admin: ${regR.status()} ${await regR.text()}`).toBeTruthy();
      otherId = readOnlyDb(db => db.prepare("SELECT id FROM users WHERE email=?").get(otherEmail))?.id;
      expect(otherId, "throwaway admin id resolved").toBeTruthy();
      await sa.post(`/api/admin/participants/${otherId}/verify`, { headers: saH });
      await sa.post(`/api/admin/participants/${otherId}/approve`, { headers: saH });
      const roleR = await sa.post(`/api/admin/participants/${otherId}/role`, {
        headers: saJsonH, data: { role: "admin" },
      });
      expect(roleR.ok(), `promote to admin: ${roleR.status()} ${await roleR.text()}`).toBeTruthy();
      const other = await apiLogin(otherEmail, otherPass);
      otherApi = other.api;
      const otherH = { "x-csrf-token": other.csrf };
      // Sanity: this really is an admin — otherwise every 4xx below is just a
      // 403 from requireAdmin and proves nothing about the ownership clause.
      expect((await otherApi.get("/api/admin/tasks")).status(),
        "the throwaway account is a working admin").toBe(200);

      // The attack: a different admin deleting a staging row they do not own.
      const crossDelete = await otherApi.delete(`/api/admin/attachment-staging/${stagingId}`, { headers: otherH });
      expect(crossDelete.status(), "a foreign admin's DELETE must not resolve the row").toBe(404);
      const afterAttack = stagingRow(stagingId);
      expect(afterAttack, "the staged ROW must survive a foreign admin's DELETE").toBeTruthy();
      expect(fsNode.existsSync(stagedFile), "the staged ZIP must survive a foreign admin's DELETE").toBe(true);

      // Sibling clause on the PATCH handler — same `admin_id=?` shape, same
      // consequence if it is dropped (a colleague renames your staged file).
      const crossPatch = await otherApi.patch(`/api/admin/attachment-staging/${stagingId}`, {
        headers: { ...otherH, "content-type": "application/json" },
        data: { display_name: "hijacked" },
      });
      expect(crossPatch.status(), "a foreign admin's PATCH must not resolve the row").toBe(404);
      expect(readOnlyDb(db => db.prepare(
        "SELECT display_name FROM task_attachments_staging WHERE id=?"
      ).get(stagingId))?.display_name, "display_name unchanged by the foreign PATCH").toBe(`Victim ${suffix}`);

      // The OWNER can still delete it — so the 404s above are the ownership
      // clause talking, not a broken route.
      const ownDelete = await sa.delete(`/api/admin/attachment-staging/${stagingId}`, { headers: saH });
      expect(ownDelete.ok(), `the owner's DELETE must succeed: ${ownDelete.status()}`).toBeTruthy();
      expect(stagingRow(stagingId), "the owner's DELETE removes the row").toBeFalsy();
      expect(fsNode.existsSync(stagedFile), "the owner's DELETE removes the bytes").toBe(false);
      stagingId = null;
    } finally {
      if (stagingId) {
        await sa.delete(`/api/admin/attachment-staging/${stagingId}`, { headers: saH }).catch(() => {});
      }
      if (otherApi) await otherApi.dispose();
      if (otherId) await sa.delete(`/api/admin/participants/${otherId}`, { headers: saH }).catch(() => {});
      await sa.dispose();
    }
  });

  test("non-admin caller gets 403 on staging endpoints", async () => {
    await ensureState();
    const { api, csrf } = await apiLogin("alice@acme.com", PARTICIPANT_PASS);
    const rPost = await api.post("/api/admin/attachment-staging", {
      headers: { "x-csrf-token": csrf },
      multipart: { file: { name: "x.zip", mimeType: "application/zip", buffer: validZipBuffer() } },
    });
    expect(rPost.status()).toBe(403);
    await api.dispose();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
test.describe("Attachment version history + restore", () => {
  // v6.13.11+ — attachment ops don't create snapshots on their own.
  // The anchor for restore is now a Save-created "update" snapshot
  // taken after the attachment is in the desired state. Each test
  // below uploads, then PUT /api/admin/tasks/:id (a no-op Save) to
  // produce a restorable snapshot, then performs the destructive
  // mutation, then restores. Net effect: identical contract, just
  // with one extra explicit Save step that reflects how an admin
  // actually uses the UI.
  test("restore after delete brings back name AND content (bytes identical)", async () => {
    await ensureState();
    const { api, csrf } = await apiLogin("superadmin");
    const tid = await createTask(api, csrf);
    await assignTaskToLive(api, csrf, tid);
    const zipBuf = validZipBuffer("seed.txt", "original-content-" + crypto.randomBytes(4).toString("hex"));
    const up = await (await api.post(`/api/admin/tasks/${tid}/attachments`, {
      headers: { "x-csrf-token": csrf },
      multipart: {
        file: { name: "pack.zip", mimeType: "application/zip", buffer: zipBuf },
        display_name: "Original",
      },
    })).json();
    // v6.13.15 — Save to create a restorable snapshot that includes
    // the attachment. Pre-v6.13.11 this was implicit in the
    // attachment_added version row; post-v6.13.11 a Save is required.
    await api.put(`/api/admin/tasks/${tid}`, { headers: h(csrf), data: {} });
    const versionsBeforeDelete = await (await api.get(`/api/admin/tasks/${tid}/versions`)).json();
    const savedVersion = versionsBeforeDelete.find(v => v.change_type === "update");
    expect(savedVersion, "Save after upload must produce an update snapshot").toBeTruthy();

    // Soft delete the attachment
    await api.delete(`/api/admin/tasks/${tid}/attachments/${up.id}`, { headers: { "x-csrf-token": csrf } });
    let listAfter = await (await api.get(`/api/admin/tasks/${tid}/attachments`)).json();
    expect(listAfter.length).toBe(0);

    // Restore the Save-snapshot → attachment re-linked.
    const r = await api.post(`/api/admin/tasks/${tid}/restore`, {
      headers: h(csrf), data: { versionId: savedVersion.id },
    });
    expect(r.ok()).toBeTruthy();
    const restoreBody = await r.json();
    expect(restoreBody.attachments_missing).toEqual([]);

    // Attachment is back in the list with the original name
    listAfter = await (await api.get(`/api/admin/tasks/${tid}/attachments`)).json();
    expect(listAfter.length).toBe(1);
    expect(listAfter[0].display_name).toBe("Original");

    // Download it and verify bytes match the original upload
    const { api: aliceApi, csrf: aliceCsrf } = await apiLogin("alice@acme.com", PARTICIPANT_PASS);
    await aliceApi.post("/api/select-competition", {
      headers: h(aliceCsrf), data: { competitionId: S.liveComp.id },
    });
    const dl = await aliceApi.get(`/api/tasks/${tid}/attachments/${up.id}`);
    expect(dl.ok()).toBeTruthy();
    const downloaded = await dl.body();
    expect(downloaded.equals(zipBuf)).toBeTruthy();
    await aliceApi.dispose();
    await api.dispose();
  });

  test("restore after rename reverts display_name", async () => {
    await ensureState();
    const { api, csrf } = await apiLogin("superadmin");
    const tid = await createTask(api, csrf);
    const up = await (await uploadAttachment(api, csrf, tid, { displayName: "Original Name" })).json();
    // Save to produce a restorable snapshot.
    await api.put(`/api/admin/tasks/${tid}`, { headers: h(csrf), data: {} });
    const versionsBefore = await (await api.get(`/api/admin/tasks/${tid}/versions`)).json();
    const savedVersion = versionsBefore.find(v => v.change_type === "update");
    expect(savedVersion).toBeTruthy();
    await api.patch(`/api/admin/tasks/${tid}/attachments/${up.id}`, {
      headers: h(csrf), data: { display_name: "Renamed" },
    });
    let list = await (await api.get(`/api/admin/tasks/${tid}/attachments`)).json();
    expect(list[0].display_name).toBe("Renamed");
    await api.post(`/api/admin/tasks/${tid}/restore`, {
      headers: h(csrf), data: { versionId: savedVersion.id },
    });
    list = await (await api.get(`/api/admin/tasks/${tid}/attachments`)).json();
    expect(list[0].display_name).toBe("Original Name");
    await api.dispose();
  });

  test("restore handles name swap without UNIQUE index conflict", async () => {
    await ensureState();
    const { api, csrf } = await apiLogin("superadmin");
    const tid = await createTask(api, csrf);
    const a = await (await uploadAttachment(api, csrf, tid, { displayName: "X" })).json();
    const b = await (await uploadAttachment(api, csrf, tid, { displayName: "Y" })).json();
    // Save so the snapshot captures A="X", B="Y".
    await api.put(`/api/admin/tasks/${tid}`, { headers: h(csrf), data: {} });
    const versions = await (await api.get(`/api/admin/tasks/${tid}/versions`)).json();
    const savedVersion = versions.find(v => v.change_type === "update");
    expect(savedVersion).toBeTruthy();
    // Rename A→Y', then B→X' then A→"Y" and B→"X" to force a swap
    await api.patch(`/api/admin/tasks/${tid}/attachments/${a.id}`, { headers: h(csrf), data: { display_name: "temp-a" } });
    await api.patch(`/api/admin/tasks/${tid}/attachments/${b.id}`, { headers: h(csrf), data: { display_name: "X" } });
    await api.patch(`/api/admin/tasks/${tid}/attachments/${a.id}`, { headers: h(csrf), data: { display_name: "Y" } });
    // Restore to the saved version where A="X", B="Y"
    const r = await api.post(`/api/admin/tasks/${tid}/restore`, {
      headers: h(csrf), data: { versionId: savedVersion.id },
    });
    expect(r.ok()).toBeTruthy();
    const list = await (await api.get(`/api/admin/tasks/${tid}/attachments`)).json();
    const byId = new Map(list.map(x => [x.id, x.display_name]));
    expect(byId.get(a.id)).toBe("X");
    expect(byId.get(b.id)).toBe("Y");
    await api.dispose();
  });

  test("restore to pre-attachment snapshot detaches attachments added after", async () => {
    // Direct-to-canonical snapshot case: the create-time snapshot has
    // attachments:[]. Adding an attachment afterwards and restoring to the
    // create version must detach the post-create attachment so current
    // state matches the restored version's attachments:[].
    await ensureState();
    const { api, csrf } = await apiLogin("superadmin");
    const tid = await createTask(api, csrf);
    const versions = await (await api.get(`/api/admin/tasks/${tid}/versions`)).json();
    const createVer = versions.find(v => v.change_type === "create");
    expect(createVer).toBeTruthy();
    expect(JSON.parse(createVer.snapshot).attachments).toEqual([]);

    await uploadAttachment(api, csrf, tid, { displayName: "post-create-add" });
    let list = await (await api.get(`/api/admin/tasks/${tid}/attachments`)).json();
    expect(list.length).toBe(1);

    const r = await api.post(`/api/admin/tasks/${tid}/restore`, {
      headers: h(csrf), data: { versionId: createVer.id },
    });
    expect(r.ok()).toBeTruthy();

    list = await (await api.get(`/api/admin/tasks/${tid}/attachments`)).json();
    expect(list.length).toBe(0);
    await api.dispose();
  });

  test("restore to legacy snapshot (no attachments key) detaches current attachments", async () => {
    // A snapshot written before v6.13.0 has no `attachments` field at all.
    // The first cut of the restore handler guarded with Array.isArray and
    // silently skipped the attachment sync for legacy snapshots, which left
    // post-feature-added attachments still attached after a restore — the
    // bug the user reported as "reverting to a pre-attachment version
    // doesn't remove the attachment". Simulate a legacy snapshot by
    // rewriting the version's snapshot column in SQLite directly, then
    // verify the restore handler now treats "no attachments key" as "state
    // had no attachments" and detaches them.
    await ensureState();
    const { api, csrf } = await apiLogin("superadmin");
    const tid = await createTask(api, csrf);
    const versions = await (await api.get(`/api/admin/tasks/${tid}/versions`)).json();
    const createVer = versions.find(v => v.change_type === "create");
    const legacySnap = JSON.parse(createVer.snapshot);
    delete legacySnap.attachments;
    const Database = require("better-sqlite3");
    const { TEST_DB_PATH } = require("./helpers");
    const db = new Database(TEST_DB_PATH);
    try {
      db.prepare("UPDATE task_versions SET snapshot=? WHERE id=?").run(JSON.stringify(legacySnap), createVer.id);
    } finally { db.close(); }

    await uploadAttachment(api, csrf, tid, { displayName: "post-legacy-add" });
    let list = await (await api.get(`/api/admin/tasks/${tid}/attachments`)).json();
    expect(list.length).toBe(1);

    const r = await api.post(`/api/admin/tasks/${tid}/restore`, {
      headers: h(csrf), data: { versionId: createVer.id },
    });
    expect(r.ok()).toBeTruthy();

    list = await (await api.get(`/api/admin/tasks/${tid}/attachments`)).json();
    expect(list.length).toBe(0);
    await api.dispose();
  });

  test("hard-delete task unlinks all attachment files (linked + detached)", async () => {
    await ensureState();
    const { api, csrf } = await apiLogin("superadmin");
    const tid = await createTask(api, csrf);
    const a = await (await uploadAttachment(api, csrf, tid, { displayName: "keeper" })).json();
    const b = await (await uploadAttachment(api, csrf, tid, { displayName: "detacher" })).json();
    await api.delete(`/api/admin/tasks/${tid}/attachments/${b.id}`, { headers: { "x-csrf-token": csrf } });
    // Delete the task; both files should be unlinked (no FS access from the
    // test context, but we can confirm the task + attachments are gone and
    // the DELETE returns ok).
    const r = await api.delete(`/api/admin/tasks/${tid}`, { headers: { "x-csrf-token": csrf } });
    expect(r.ok()).toBeTruthy();
    // Follow-up admin list should 404 the task's attachments
    const list = await api.get(`/api/admin/tasks/${tid}/attachments`);
    expect(list.ok()).toBeTruthy();
    expect((await list.json()).length).toBe(0);
    await api.dispose();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
test.describe("JSON export/import — attachments round-trip", () => {
  test("export includes attachments with base64 content + sha256", async () => {
    await ensureState();
    const { api, csrf } = await apiLogin("superadmin");
    const exportableTitle = `Exportable ${Date.now()}`;
    const tid = await createTask(api, csrf, { title: exportableTitle });
    const zipBuf = validZipBuffer("readme.txt", "export-payload-" + crypto.randomBytes(3).toString("hex"));
    await api.post(`/api/admin/tasks/${tid}/attachments`, {
      headers: { "x-csrf-token": csrf },
      multipart: {
        file: { name: "pack.zip", mimeType: "application/zip", buffer: zipBuf },
        display_name: "Export Sample",
      },
    });
    const r = await api.get("/api/admin/export/tasks");
    expect(r.ok()).toBeTruthy();
    const body = await r.json();
    const exported = body.tasks.find(t => t.title === exportableTitle);
    expect(exported).toBeTruthy();
    expect(Array.isArray(exported.attachments)).toBeTruthy();
    expect(exported.attachments.length).toBe(1);
    const att = exported.attachments[0];
    expect(att.display_name).toBe("Export Sample");
    expect(att.sha256).toBe(crypto.createHash("sha256").update(zipBuf).digest("hex"));
    expect(Buffer.from(att.content_b64, "base64").equals(zipBuf)).toBeTruthy();
    await api.dispose();
  });

  test("export with include_attachment_content=0 omits content_b64", async () => {
    await ensureState();
    const { api, csrf } = await apiLogin("superadmin");
    const tid = await createTask(api, csrf, { title: `ExportMetaOnly ${Date.now()}` });
    await uploadAttachment(api, csrf, tid, { displayName: "meta only" });
    const body = await (await api.get("/api/admin/export/tasks?include_attachment_content=0")).json();
    const exported = body.tasks.find(t => t.attachments && t.attachments.some(a => a.display_name === "meta only"));
    expect(exported).toBeTruthy();
    expect(exported.attachments[0]).toHaveProperty("display_name");
    expect(exported.attachments[0]).toHaveProperty("sha256");
    expect(exported.attachments[0].content_b64).toBeUndefined();
    await api.dispose();
  });

  test("import round-trip: export → delete task → import → bytes identical", async () => {
    await ensureState();
    const { api, csrf } = await apiLogin("superadmin");
    const origTitle = `Roundtrip ${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
    const tid = await createTask(api, csrf, { title: origTitle });
    await assignTaskToLive(api, csrf, tid);
    const zipBuf = validZipBuffer("greet.txt", "roundtrip-payload-" + crypto.randomBytes(3).toString("hex"));
    await api.post(`/api/admin/tasks/${tid}/attachments`, {
      headers: { "x-csrf-token": csrf },
      multipart: {
        file: { name: "pack.zip", mimeType: "application/zip", buffer: zipBuf },
        display_name: "Greet",
      },
    });

    // Export
    const exportBody = await (await api.get("/api/admin/export/tasks")).json();
    const exportedTask = exportBody.tasks.find(t => t.title === origTitle);
    expect(exportedTask).toBeTruthy();
    expect(exportedTask.attachments.length).toBe(1);

    // Remove the task from the competition first, then delete it
    await api.delete(`/api/admin/tasks/${tid}/competitions/${S.liveComp.id}`, { headers: { "x-csrf-token": csrf } });
    await api.delete(`/api/admin/tasks/${tid}`, { headers: { "x-csrf-token": csrf } });

    // Import (dry run + apply)
    const importData = { type: "hackarena-tasks", version: 1, tasks: [exportedTask] };
    const dry = await (await api.post("/api/admin/import/tasks", {
      headers: h(csrf), data: { data: importData },
    })).json();
    expect(dry.dryRun).toBeTruthy();
    const apply = await (await api.post("/api/admin/import/tasks", {
      headers: h(csrf), data: { data: importData, resolutions: {} },
    })).json();
    expect(apply.ok).toBeTruthy();
    expect(apply.imported).toBe(1);
    expect(apply.attachments_imported).toBe(1);

    // Find the re-created task + verify the attachment bytes match
    const tasks = await (await api.get("/api/admin/tasks")).json();
    const recreated = tasks.find(t => t.title === origTitle);
    expect(recreated).toBeTruthy();
    const list = await (await api.get(`/api/admin/tasks/${recreated.id}/attachments`)).json();
    expect(list.length).toBe(1);
    expect(list[0].display_name).toBe("Greet");
    // Participant downloads via the re-created task (assign first)
    await api.post(`/api/admin/tasks/${recreated.id}/competitions`, {
      headers: h(csrf), data: { competitionIds: [S.liveComp.id] },
    });
    await api.dispose();

    const { api: aliceApi, csrf: aliceCsrf } = await apiLogin("alice@acme.com", PARTICIPANT_PASS);
    await aliceApi.post("/api/select-competition", { headers: h(aliceCsrf), data: { competitionId: S.liveComp.id } });
    const dl = await aliceApi.get(`/api/tasks/${recreated.id}/attachments/${list[0].id}`);
    expect(dl.ok()).toBeTruthy();
    expect((await dl.body()).equals(zipBuf)).toBeTruthy();
    await aliceApi.dispose();
  });

  test("import rejects attachment with sha256 mismatch", async () => {
    await ensureState();
    const { api, csrf } = await apiLogin("superadmin");
    const zipBuf = validZipBuffer();
    const payload = {
      data: {
        type: "hackarena-tasks", version: 1,
        tasks: [{
          title: `Bad SHA ${Date.now()}`,
          difficulty: "easy", answer_type: "text", correct_answer: "a", status: "draft",
          attachments: [{
            display_name: "tampered",
            original_name: "x.zip",
            size_bytes: zipBuf.length,
            sha256: "deadbeef".repeat(8),
            order_idx: 0,
            content_b64: zipBuf.toString("base64"),
          }],
        }],
      },
      resolutions: {},
    };
    const r = await api.post("/api/admin/import/tasks", { headers: h(csrf), data: payload });
    expect(r.status()).toBe(400);
    expect((await r.json()).error).toMatch(/sha256/i);
    await api.dispose();
  });

  test("import rejects encrypted attachment", async () => {
    await ensureState();
    const { api, csrf } = await apiLogin("superadmin");
    const encBuf = encryptedZipBuffer();
    const payload = {
      data: {
        type: "hackarena-tasks", version: 1,
        tasks: [{
          title: `Enc Import ${Date.now()}`,
          difficulty: "easy", answer_type: "text", correct_answer: "a", status: "draft",
          attachments: [{
            display_name: "secret",
            original_name: "s.zip",
            size_bytes: encBuf.length,
            order_idx: 0,
            content_b64: encBuf.toString("base64"),
          }],
        }],
      },
      resolutions: {},
    };
    const r = await api.post("/api/admin/import/tasks", { headers: h(csrf), data: payload });
    expect(r.status()).toBe(400);
    expect((await r.json()).error).toMatch(/encrypted/i);
    await api.dispose();
  });

  test("import without content_b64 skips the attachment silently", async () => {
    await ensureState();
    const { api, csrf } = await apiLogin("superadmin");
    const payload = {
      data: {
        type: "hackarena-tasks", version: 1,
        tasks: [{
          title: `MetaOnly Import ${Date.now()}`,
          difficulty: "easy", answer_type: "text", correct_answer: "a", status: "draft",
          attachments: [{
            display_name: "metadata-only",
            original_name: "m.zip",
            size_bytes: 999,
            sha256: "00".repeat(32),
            order_idx: 0,
          }],
        }],
      },
      resolutions: {},
    };
    const r = await api.post("/api/admin/import/tasks", { headers: h(csrf), data: payload });
    expect(r.ok()).toBeTruthy();
    const body = await r.json();
    expect(body.imported).toBe(1);
    expect(body.attachments_imported).toBe(0);
    await api.dispose();
  });

  test("import as non-superadmin returns 403", async () => {
    // Existing seed has only superadmin, no plain admin. Use a regular
    // participant — requireAdmin alone catches them.
    await ensureState();
    const { api, csrf } = await apiLogin("alice@acme.com", PARTICIPANT_PASS);
    const r = await api.post("/api/admin/import/tasks", {
      headers: h(csrf),
      data: { data: { type: "hackarena-tasks", version: 1, tasks: [] }, resolutions: {} },
    });
    expect(r.status()).toBe(403);
    await api.dispose();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Rollback semantics when the filesystem fails AFTER the metadata-validation
// stage but DURING the move into ./data/attachments/. The reviewer flagged
// the pre-fix behaviour as silent data loss: an ENOSPC / EACCES from
// renameSync would leave task_attachments rows pointing at files that never
// got written. The fix pre-moves files and runs the DB txn last, rolling
// back the moves if the txn throws. These tests cheaply simulate move
// failures by sabotaging the source file between upload and promote.
// ═══════════════════════════════════════════════════════════════════════════
const fsNode = require("fs");
const pathNode = require("path");
const { TEST_DATA_DIR } = require("./helpers");

test.describe("File-move rollback — promotion + import stay consistent on I/O failure", () => {
  test("promotion: deleted staging file → 500, no task created, no dangling attachment row", async () => {
    await ensureState();
    const { api, csrf } = await apiLogin("superadmin");
    const staged = await (await api.post("/api/admin/attachment-staging", {
      headers: { "x-csrf-token": csrf },
      multipart: {
        file: { name: "boom.zip", mimeType: "application/zip", buffer: validZipBuffer() },
        display_name: "boom",
      },
    })).json();
    // Sabotage the staging file on disk so renameSync fails with ENOENT.
    // The staging row is still in the DB — the server validates the row
    // exists and is owned by us BEFORE trying the move.
    const stagingDir = pathNode.join(TEST_DATA_DIR, "attachments-staging");
    for (const f of fsNode.readdirSync(stagingDir)) {
      if (f.startsWith(staged.staging_id)) fsNode.unlinkSync(pathNode.join(stagingDir, f));
    }
    const titleForFailedCreate = `PromotionFailCheck ${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
    const r = await api.post("/api/admin/tasks", {
      headers: h(csrf),
      data: {
        title: titleForFailedCreate,
        difficulty: "easy", answer_type: "text", correct_answer: "a", status: "published",
        staging_attachments: [{ staging_id: staged.staging_id }],
      },
    });
    expect(r.status()).toBe(500);
    // No task row was inserted.
    const tasks = await (await api.get("/api/admin/tasks")).json();
    expect(tasks.find(t => t.title === titleForFailedCreate)).toBeUndefined();
    // Cleanup the dangling staging row so it doesn't linger into other tests.
    await api.delete(`/api/admin/attachment-staging/${staged.staging_id}`, {
      headers: { "x-csrf-token": csrf },
    });
    await api.dispose();
  });

  test("promotion: first move succeeds, second fails → both rolled back, first file returned to staging", async () => {
    await ensureState();
    const { api, csrf } = await apiLogin("superadmin");
    const a = await (await api.post("/api/admin/attachment-staging", {
      headers: { "x-csrf-token": csrf },
      multipart: {
        file: { name: "a.zip", mimeType: "application/zip", buffer: validZipBuffer("a.txt", "A") },
        display_name: "survivor",
      },
    })).json();
    const b = await (await api.post("/api/admin/attachment-staging", {
      headers: { "x-csrf-token": csrf },
      multipart: {
        file: { name: "b.zip", mimeType: "application/zip", buffer: validZipBuffer("b.txt", "B") },
        display_name: "doomed",
      },
    })).json();
    // Sabotage ONLY the second staging file. The first move succeeds; the
    // second fails; we expect both to be rolled back so the first staging
    // row is still fully usable.
    const stagingDir = pathNode.join(TEST_DATA_DIR, "attachments-staging");
    for (const f of fsNode.readdirSync(stagingDir)) {
      if (f.startsWith(b.staging_id)) fsNode.unlinkSync(pathNode.join(stagingDir, f));
    }
    const titleForFailedCreate = `RollbackA+B ${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
    const r = await api.post("/api/admin/tasks", {
      headers: h(csrf),
      data: {
        title: titleForFailedCreate,
        difficulty: "easy", answer_type: "text", correct_answer: "a", status: "published",
        staging_attachments: [
          { staging_id: a.staging_id, display_name: "survivor" },
          { staging_id: b.staging_id, display_name: "doomed" },
        ],
      },
    });
    expect(r.status()).toBe(500);
    const tasks = await (await api.get("/api/admin/tasks")).json();
    expect(tasks.find(t => t.title === titleForFailedCreate)).toBeUndefined();
    // The SURVIVOR staging file must still be present (it got rolled back).
    // Re-submit the same staging_id in a fresh task — should succeed.
    const retryTitle = `RollbackRetry ${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
    const retry = await api.post("/api/admin/tasks", {
      headers: h(csrf),
      data: {
        title: retryTitle,
        difficulty: "easy", answer_type: "text", correct_answer: "a", status: "published",
        staging_attachments: [{ staging_id: a.staging_id, display_name: "survivor" }],
      },
    });
    expect(retry.ok()).toBeTruthy();
    const created = await retry.json();
    const list = await (await api.get(`/api/admin/tasks/${created.id}/attachments`)).json();
    expect(list.length).toBe(1);
    expect(list[0].display_name).toBe("survivor");
    // Clean up the still-dangling "doomed" staging row (file gone, row remains).
    await api.delete(`/api/admin/attachment-staging/${b.staging_id}`, {
      headers: { "x-csrf-token": csrf },
    });
    await api.dispose();
  });

  test("import: attachments dir read-only → 500, no task / no attachment rows", async () => {
    await ensureState();
    const { api, csrf } = await apiLogin("superadmin");
    const zipBuf = validZipBuffer("seed.txt", "import-rollback-" + crypto.randomBytes(3).toString("hex"));
    const title = `ImportFail ${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
    const payload = {
      data: {
        type: "hackarena-tasks", version: 1,
        tasks: [{
          title,
          difficulty: "easy", answer_type: "text", correct_answer: "a", status: "draft",
          attachments: [{
            display_name: "pack",
            original_name: "pack.zip",
            size_bytes: zipBuf.length,
            sha256: crypto.createHash("sha256").update(zipBuf).digest("hex"),
            order_idx: 0,
            content_b64: zipBuf.toString("base64"),
          }],
        }],
      },
      resolutions: {},
    };
    const attachmentsDir = pathNode.join(TEST_DATA_DIR, "attachments");
    const originalMode = fsNode.statSync(attachmentsDir).mode;
    try {
      // Read + execute only — no writes. renameSync / copyFileSync into this
      // directory now fails with EACCES.
      // v7.15.22 — chmod cannot deny ROOT. In the CI container the suite runs as
      // root (HOME=/root; the image's own docs pin it so Firefox will launch),
      // and root bypasses directory permission bits entirely — so the write
      // SUCCEEDS, no 500 is produced, and this test fails for a reason that has
      // nothing to do with the behaviour it guards. It is a genuine
      // environment incompatibility, not a flake: it can never pass as root.
      if (typeof process.getuid === "function" && process.getuid() === 0) {
        test.skip(true, "chmod cannot deny root — this permission-failure path is unobservable when running as uid 0");
      }
      fsNode.chmodSync(attachmentsDir, 0o500);
      const r = await api.post("/api/admin/import/tasks", { headers: h(csrf), data: payload });
      expect(r.status()).toBe(500);
    } finally {
      fsNode.chmodSync(attachmentsDir, originalMode);
    }
    // No task with our unique title should exist — the txn never ran.
    const tasks = await (await api.get("/api/admin/tasks")).json();
    expect(tasks.find(t => t.title === title)).toBeUndefined();
    await api.dispose();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
test.describe("Icon + TASK_FIELDS regression locks", () => {
  const fs = require("fs");
  const path = require("path");
  const appJs = (() => { const _d = path.join(__dirname, "..", "public", "js"); const _o = []; (function _w(p){ for (const e of fs.readdirSync(p, { withFileTypes: true })) { const _f = path.join(p, e.name); if (e.isDirectory()) _w(_f); else if (e.name.endsWith(".js")) _o.push(fs.readFileSync(_f, "utf8")); } })(_d); return _o.join("\n"); })();
  const stylesCss = fs.readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8");

  test("ICO.download is defined and used", () => {
    expect(/ICO\s*=\s*\{[\s\S]*?download\s*:\s*_SVG/.test(appJs)).toBeTruthy();
    expect(appJs).toContain("ICO.download");
  });

  test("TASK_FIELDS includes 'attachments'", () => {
    const match = appJs.match(/const\s+TASK_FIELDS\s*=\s*(\[[^\]]+\])/);
    expect(match).toBeTruthy();
    expect(match[1]).toContain("'attachments'");
  });

  test("admin preview ('View as Participant') fetches + renders attachments", () => {
    // The preview is driven by viewTaskAsParticipant(). A regression where it
    // stops fetching attachments — as happened on the first cut of this
    // feature — is invisible to the API-level staging tests because they
    // don't drive the client. Lock the fetch + render wiring so a refactor
    // that drops either is a hard failure.
    const fnMatch = appJs.match(/async function viewTaskAsParticipant\([\s\S]*?\n\}/);
    expect(fnMatch, "viewTaskAsParticipant must be async (fetches attachments)").toBeTruthy();
    const body = fnMatch[0];
    expect(body, "viewTaskAsParticipant must fetch attachments").toMatch(
      /\/api\/admin\/tasks\/\$\{taskId\}\/attachments/
    );
    expect(body, "viewTaskAsParticipant must render a .task-preview-attachments block").toContain(
      "task-preview-attachments"
    );
    // The download links must point at the admin-scoped endpoint so an
    // admin previewing outside a competition scope doesn't hit 403.
    expect(body).toContain("/api/admin/tasks/${esc(taskId)}/attachments/${esc(a.id)}");
    // Styles exist for the new preview section.
    expect(stylesCss).toMatch(/\.task-preview-attachments\s*\{/);
    expect(stylesCss).toMatch(/\.task-preview-attachment-link\s*\{/);
  });

  test("attachment rename/delete on live-comp challenges show a live-competition warning (upload staged per v6.13.15)", () => {
    // Contract evolution:
    //   Pre-v6.13.13: upload/rename/delete all fired
    //   _confirmLiveChallengeMutation.
    //   v6.13.13: upload's live-comp confirm removed (redundant with
    //   saveTask's). Rename + delete still fire — they're immediate.
    //   v6.13.15: uploads route through the staging endpoint, which
    //   is invisible to participants until Save, so the live-comp
    //   gate at Save time is the single source of truth for upload.
    // Lock that shape in: rename + delete still call the helper,
    // upload no longer does, and the helper itself still exists and
    // filters live comps.
    const up = appJs.match(/async function _uploadAttachmentNow\([\s\S]*?\n\}/);
    const del = appJs.match(/async function _deleteSavedAttachment\([\s\S]*?\n\}/);
    const ren = appJs.match(/async function _renameSavedAttachment\([\s\S]*?\n\}/);
    expect(up, "upload helper").toBeTruthy();
    expect(del, "delete helper").toBeTruthy();
    expect(ren, "rename helper").toBeTruthy();
    expect(up[0], "upload must NOT fire _confirmLiveChallengeMutation (staged; Save gates visibility)")
      .not.toContain("_confirmLiveChallengeMutation");
    expect(del[0], "delete still fires immediately — live-comp confirm still required")
      .toContain("_confirmLiveChallengeMutation");
    expect(ren[0], "rename still fires immediately — live-comp confirm still required")
      .toContain("_confirmLiveChallengeMutation");
    // The helper itself reads `competitions` + filters status==='live'.
    expect(appJs).toMatch(/async function _confirmLiveChallengeMutation[\s\S]*?status==='live'/);
  });

  test("restore handler closes the history dialog + refreshes CSRF", () => {
    // Pre-fix the restore flow left the history dialog open and kept the
    // cached CSRF token, which explained both sides of the reported
    // "restore logged me out" / "restore didn't take effect" surprise:
    // a stale token 403s into a session-expired redirect, and the open
    // dialog read as "nothing happened". Lock the two UX changes in.
    const fn = appJs.match(/async function restoreTaskVersion\([\s\S]*?\n\}/);
    expect(fn, "restoreTaskVersion source block").toBeTruthy();
    expect(fn[0]).toContain("await loadCsrfToken()");
    expect(fn[0]).toContain("closeHistoryDialog()");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
test.describe("v6.13.17 — attachment edge cases", () => {
  test("restore surfaces hard-deleted attachment rows in attachments_missing", async () => {
    // Context: the restore txn soft-detaches every currently-linked row
    // then re-links rows the snapshot names via their `id`. A snapshot row
    // whose `task_attachments` entry has been hard-deleted (outside the
    // normal soft-delete flow — e.g. manual DB surgery, or a task
    // recreated with the same id) cannot be re-linked and must surface in
    // the `attachments_missing` response so the admin knows the binary is
    // gone. Pre-v6.13 the field was undocumented; lock the contract now.
    await ensureState();
    const { api, csrf } = await apiLogin("superadmin");
    const tid = await createTask(api, csrf);
    const zipBuf = validZipBuffer("s.txt", "hard-delete-" + crypto.randomBytes(4).toString("hex"));
    const up = await (await api.post(`/api/admin/tasks/${tid}/attachments`, {
      headers: { "x-csrf-token": csrf },
      multipart: { file: { name: "p.zip", mimeType: "application/zip", buffer: zipBuf }, display_name: "Ghost" },
    })).json();
    // Save to create a restorable snapshot that references the attachment row.
    await api.put(`/api/admin/tasks/${tid}`, { headers: h(csrf), data: {} });
    const versions = await (await api.get(`/api/admin/tasks/${tid}/versions`)).json();
    const saved = versions.find(v => v.change_type === "update");
    expect(saved, "Save must create an update snapshot").toBeTruthy();
    // Hard-delete the row (bypassing the soft-detach API path) so the
    // probe stmt inside restoreTxn returns falsy for this id.
    const Database = require("better-sqlite3");
    const { TEST_DB_PATH } = require("./helpers");
    const db = new Database(TEST_DB_PATH);
    try { db.prepare("DELETE FROM task_attachments WHERE id=?").run(up.id); }
    finally { db.close(); }
    const r = await api.post(`/api/admin/tasks/${tid}/restore`, {
      headers: h(csrf), data: { versionId: saved.id },
    });
    expect(r.ok()).toBeTruthy();
    const body = await r.json();
    expect(Array.isArray(body.attachments_missing)).toBe(true);
    expect(body.attachments_missing.length).toBe(1);
    expect(body.attachments_missing[0].id).toBe(up.id);
    expect(body.attachments_missing[0].display_name).toBe("Ghost");
    // The restored task carries no attachments (can't re-link a missing row).
    const list = await (await api.get(`/api/admin/tasks/${tid}/attachments`)).json();
    expect(list.length).toBe(0);
    // A restore audit row is still written.
    const vAfter = await (await api.get(`/api/admin/tasks/${tid}/versions`)).json();
    expect(vAfter.find(v => v.change_type === "restore"), "restore must write its own audit row").toBeTruthy();
    await api.dispose();
  });

  test("PUT /api/admin/tasks/:id rejects 409 when staging promotion would exceed ATTACHMENT_MAX_PER_TASK", async () => {
    // Contract lock: the server caps attachments at 10/task (v6.13.17
    // reads ATTACHMENT_MAX_PER_TASK from server.js:813). Both the POST
    // create path and the PUT edit path must enforce it — exercise the
    // PUT path, which is the higher-risk one because a partial staging
    // queue left over from an interrupted Save could combine with fresh
    // uploads to blow past the cap.
    await ensureState();
    const { api, csrf } = await apiLogin("superadmin");
    const tid = await createTask(api, csrf);
    // Push the task to 10 attachments via direct POST uploads.
    for (let i = 0; i < 10; i++) {
      const zip = validZipBuffer(`f${i}.txt`, `d${i}`);
      const r = await api.post(`/api/admin/tasks/${tid}/attachments`, {
        headers: { "x-csrf-token": csrf },
        multipart: { file: { name: `a${i}.zip`, mimeType: "application/zip", buffer: zip }, display_name: `A${i}` },
      });
      expect(r.ok(), `upload ${i} must succeed`).toBeTruthy();
    }
    const full = await (await api.get(`/api/admin/tasks/${tid}/attachments`)).json();
    expect(full.length).toBe(10);
    // Stage an 11th via the staging endpoint, then try to promote it on Save.
    const staged = await (await api.post("/api/admin/attachment-staging", {
      headers: { "x-csrf-token": csrf },
      multipart: { file: { name: "overflow.zip", mimeType: "application/zip", buffer: validZipBuffer("r.txt", "x") } },
    })).json();
    expect(staged.staging_id, "staging endpoint returned an id").toBeTruthy();
    const put = await api.put(`/api/admin/tasks/${tid}`, {
      headers: h(csrf),
      data: { staging_attachments: [{ staging_id: staged.staging_id, display_name: "over" }] },
    });
    expect(put.status(), "PUT must 409 when promotion would exceed the cap").toBe(409);
    const body = await put.json();
    expect(body.error, "409 body must mention the 10-per-task cap").toMatch(/Maximum 10 attachments per challenge/);
    // Count unchanged.
    const after = await (await api.get(`/api/admin/tasks/${tid}/attachments`)).json();
    expect(after.length).toBe(10);
    // Cleanup staging so the janitor doesn't trip on orphan bytes.
    await api.delete(`/api/admin/attachment-staging/${staged.staging_id}`, {
      headers: { "x-csrf-token": csrf },
    }).catch(() => {});
    await api.dispose();
  });
});

// audit v7.7.29 batch 4 (M6) — a competition-scoped task export must include
// the scoped tasks' attachments (round-trip), proving the task_id IN (...)
// scoping added to fix the platform-wide 413 didn't drop wanted attachments.
test.describe("audit v7.7.29 (M6) — scoped export includes its tasks' attachments", () => {
  test("export?competitionId round-trips a scoped task's attachment content", async () => {
    await ensureState();
    const { api, csrf } = await apiLogin("superadmin");
    const s = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e5)}`;
    // Fresh comp + one task with an attachment, assigned to it.
    const comp = (await (await api.post("/api/admin/competitions", { headers: h(csrf), data: {
      name: `M6 ${s}`, start_time: new Date(Date.now() + 3600_000).toISOString(), duration_minutes: 60,
    }})).json()).competition;
    const tid = await createTask(api, csrf);
    const scopedZip = validZipBuffer("README.txt", "scoped-payload");
    const up = await uploadAttachment(api, csrf, tid, { displayName: "Scoped pack", zipBuf: scopedZip });
    expect(up.ok()).toBeTruthy();
    await api.post(`/api/admin/tasks/${tid}/competitions`, { headers: h(csrf), data: { competitionIds: [comp.id] } });
    // A SEPARATE unrelated task also carries an attachment (must not break the
    // scoped export nor be counted against it).
    const other = await createTask(api, csrf);
    await uploadAttachment(api, csrf, other, { displayName: "Unrelated", body: "unrelated" });

    const r = await api.get(`/api/admin/export/tasks?competitionId=${comp.id}&include_attachment_content=1`);
    expect(r.status(), "scoped export must 200 despite unrelated platform attachments").toBe(200);
    const body = await r.json();
    expect(body.tasks.length).toBe(1);
    const atts = body.tasks[0].attachments || [];
    expect(atts.length, "the scoped task's attachment must be present").toBe(1);
    expect(atts[0].display_name).toBe("Scoped pack");
    expect(Buffer.from(atts[0].content_b64, "base64").equals(scopedZip), "attachment bytes round-trip in the scoped export").toBe(true);
    await api.dispose();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ext-audit v7.15.13 (MEDIUM) — the staging budget must have a GLOBAL ceiling
// ═══════════════════════════════════════════════════════════════════════════════
// The byte quota was per-admin only, so the volume the server could be asked to
// absorb scaled with the number of admin accounts: N admins × 512 MB. The
// free-disk floor is the only other brake and it fires one upload too late.
test.describe("Global attachment staging quota (v7.15.13)", () => {
  const Database = require("better-sqlite3");
  const { TEST_DB_PATH } = require("./helpers");

  test("another admin's staged bytes count against this admin's upload", async () => {
    const { api, csrf } = await apiLogin("superadmin");
    const planted = [];
    try {
      // Plant staging rows for a DIFFERENT admin whose sizes exceed the global
      // ceiling. Only the size_bytes column matters to the quota arithmetic, so
      // no bytes are actually written — this is the fleet-wide pile-up the cap
      // exists to stop, produced cheaply.
      const GLOBAL_CAP = 4 * 1024 * 1024 * 1024;
      const db = new Database(TEST_DB_PATH);
      try {
        const ins = db.prepare(
          "INSERT INTO task_attachments_staging (id, admin_id, display_name, original_name, size_bytes, sha256, storage_path, created_at) VALUES (?,?,?,?,?,?,?,?)"
        );
        for (let i = 0; i < 5; i++) {
          const id = require("crypto").randomUUID();
          planted.push(id);
          ins.run(id, `other-admin-${i}@example.com`, `bulk${i}`, `bulk${i}.zip`,
                  Math.ceil(GLOBAL_CAP / 4), "0".repeat(64), `attachments-staging/${id}.zip`,
                  new Date().toISOString());
        }
      } finally { db.close(); }

      const r = await api.post("/api/admin/attachment-staging", {
        headers: { "x-csrf-token": csrf },
        multipart: {
          display_name: "over-global",
          file: { name: "a.zip", mimeType: "application/zip", buffer: validZipBuffer() },
        },
      });
      expect(r.status(),
        "with the server-wide staging pool already over its ceiling, a further upload must be refused — " +
        "a per-admin-only quota lets N admins each consume the full cap"
      ).toBe(507);
      expect((await r.json()).error).toMatch(/server-wide/i);
    } finally {
      const dbC = new Database(TEST_DB_PATH);
      try {
        const del = dbC.prepare("DELETE FROM task_attachments_staging WHERE id=?");
        for (const id of planted) del.run(id);
      } finally { dbC.close(); }
      await api.dispose();
    }
  });

  // ext-audit v7.15.15 — the preflight must RESERVE, not merely check.
  // v7.15.13/14 checked free space and quota before multer and took the real
  // reservation only afterwards, so N concurrent uploads all measured the same
  // state and all passed — the same check-then-act defect v7.15.11 fixed one
  // layer deeper. Concurrency is what distinguishes the two.
  test("concurrent uploads cannot all pass the same preflight reading", async () => {
    const { api, csrf } = await apiLogin("superadmin");
    const planted = [];
    try {
      // Seed the pool just under the global ceiling, leaving room for ONE more
      // upload but not for several.
      const GLOBAL_CAP = 4 * 1024 * 1024 * 1024;
      // A MULTI-MEGABYTE body on purpose. With a few-hundred-byte zip each
      // request finishes multer before the next one's preflight runs, so the
      // shared in-flight counter alone catches the surplus and the test cannot
      // distinguish a reserving preflight from a checking one. A large body
      // keeps several requests inside multer simultaneously, which is the state
      // the reservation exists for.
      const zip = validZipBuffer("BIG.txt", "z".repeat(3 * 1024 * 1024));
      const headroom = Math.floor(zip.length * 2.5);   // room for ~2, not ~6
      const db = new Database(TEST_DB_PATH);
      try {
        const id = require("crypto").randomUUID();
        planted.push(id);
        db.prepare(
          "INSERT INTO task_attachments_staging (id, admin_id, display_name, original_name, size_bytes, sha256, storage_path, created_at) VALUES (?,?,?,?,?,?,?,?)"
        ).run(id, `pf-other-${Date.now()}`, "bulk", "bulk.zip", GLOBAL_CAP - headroom,
              "0".repeat(64), `attachments-staging/${id}.zip`, new Date().toISOString());
      } finally { db.close(); }

      // Six simultaneous uploads against room for about two. Without a
      // reservation every one of them sees the same healthy reading and is
      // admitted; with one, the surplus is refused.
      // v7.15.18 — RETRY THE BURST. The property under test is "when several
      // uploads are inside multer at once, the preflight refuses the surplus",
      // and whether they actually overlap is load-dependent: under a full
      // 8-worker run the server can serialise them, each finishing and
      // releasing before the next begins, so no burst overlaps and nothing is
      // refused. Retrying the burst preserves the assertion exactly — it must
      // still see a PREFLIGHT refusal — while not depending on one attempt
      // happening to interleave.
      const N = 6;
      let accepted = [], refusals = [];
      // v7.21.15 — a refused request may never yield a RESPONSE at all.
      //
      // The preflight answers while the client is still streaming a 3 MB body,
      // and drains a body this size rather than cutting it (lib/http.js
      // refuseBeforeBody), so a reset is not expected. A cut connection would
      // surface in Playwright as a THROWN `write ECONNRESET` rather than a
      // response object, rejecting Promise.all on the run where the mechanism
      // under test works hardest, so one is still caught and counted, for the
      // reason below.
      //
      // A reset here IS a preflight refusal: the post-multer gate answers only
      // after the whole body has been received, so it never tears down a socket
      // mid-upload, and a check-only preflight would have admitted all six and
      // returned 200s. So it is counted as one — with the reason recorded, and
      // NOT folded into the "upload quota exceeded" text match, which stays a
      // separate, stronger signal.
      const CONN_RESET = /ECONNRESET|socket hang up|aborted|ECONNABORTED|EPIPE/i;
      let earlyResets = 0;
      for (let attempt = 0; attempt < 3; attempt++) {
        // The disk floor is asked before the quota (awaitUploadRoom).
        await awaitUploadRoom(N * zip.length);
        const settled = await Promise.all(Array.from({ length: N }, (_, i) =>
          api.post("/api/admin/attachment-staging", {
            headers: { "x-csrf-token": csrf },
            multipart: {
              display_name: `race${attempt}-${i}`,
              file: { name: `r${attempt}-${i}.zip`, mimeType: "application/zip", buffer: zip },
            },
          }).catch(e => ({ _connErr: String((e && e.message) || e) }))
        ));
        const results = settled.filter(r => !r._connErr);
        earlyResets += settled.filter(r => r._connErr && CONN_RESET.test(r._connErr)).length;
        // Anything that threw for another reason is a real failure, not evidence.
        const unexpected = settled.filter(r => r._connErr && !CONN_RESET.test(r._connErr));
        expect(unexpected.map(r => r._connErr),
          "an upload failed for a reason other than the server closing the socket on a refusal"
        ).toEqual([]);
        accepted = results.filter(r => r.ok());
        refusals = await Promise.all(results.filter(r => !r.ok()).map(r => r.text()));
        // Clear this attempt's rows so the next burst starts from the same state.
        for (const r of accepted) {
          const id = (await r.json()).id;
          if (id) await api.delete(`/api/admin/attachment-staging/${id}`, { headers: { "x-csrf-token": csrf } });
        }
        if (refusals.some(t => /upload quota exceeded/i.test(t)) || earlyResets > 0) break;
      }
      // The two gates word their refusals differently on purpose — the preflight
      // says "upload quota", the post-multer path says "staging quota" — so this
      // asserts the surplus was refused BEFORE its body reached disk.
      //
      // v7.15.18 — be honest about what this does and does not prove. Its
      // discriminating power is timing-dependent: whether requests actually
      // overlap inside multer varies with load, and the preflight's global check
      // also reads in-flight bytes reserved by the POST-multer path, so a
      // check-only preflight can incidentally refuse too once a burst happens to
      // interleave. This test is therefore a behavioural exercise of the
      // concurrent path, not the guarantee.
      //
      // The DETERMINISTIC guarantee that the preflight holds a reservation at
      // all is the source pin in functional-core.api.spec.js, "the attachment
      // preflight RESERVES, it does not merely check" — verified to fail when
      // the reservation is removed. Do not delete that one thinking this
      // covers it.
      expect(refusals.some(t => /upload quota exceeded/i.test(t)) || earlyResets > 0,
        `at least one request must be refused BEFORE its body is written — ` +
        `refusals seen: ${JSON.stringify(refusals)}; sockets closed mid-upload: ${earlyResets}`
      ).toBeTruthy();
    } finally {
      const dbC = new Database(TEST_DB_PATH);
      try { const del = dbC.prepare("DELETE FROM task_attachments_staging WHERE id=?"); for (const id of planted) del.run(id); }
      finally { dbC.close(); }
      await api.dispose();
    }
  });

  test("the same upload succeeds once the global pool drains", async () => {
    // The other half: the cap must not be a permanent block. With nothing
    // planted, the identical upload goes through.
    const { api, csrf } = await apiLogin("superadmin");
    try {
      const r = await api.post("/api/admin/attachment-staging", {
        headers: { "x-csrf-token": csrf },
        multipart: {
          display_name: "under-global",
          file: { name: "a.zip", mimeType: "application/zip", buffer: validZipBuffer() },
        },
      });
      expect(r.status(), `an ordinary upload must still work: ${await r.text()}`).toBe(200);
      const id = (await r.json()).id;
      if (id) await api.delete(`/api/admin/attachment-staging/${id}`, { headers: { "x-csrf-token": csrf } });
    } finally { await api.dispose(); }
  });
});
