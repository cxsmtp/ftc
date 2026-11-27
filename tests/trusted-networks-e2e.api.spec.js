// @ts-check
//
// v7.16.6 — the ONLY test that drives the trusted-networks feature end to end
// against the failure it was built for.
//
// Every part of this shipped with its own coverage, but nothing exercised the
// whole chain: a REAL scanner cascade blocks a venue's address, an alert
// reaches an admin, the admin follows the alert's instructions, and the block
// lifts. "The parts work" is a different claim from "the feature works", and
// the gap between them is where a feature like this usually dies.
//
// WHY IT SPAWNS ITS OWN SERVER. The interesting question is what happens to an
// admin who is NOT on the affected network, and in the shared test server every
// client is 127.0.0.1. TRUST_PROXY + X-Forwarded-For gives two distinct
// identities — a venue address and an admin address — which is also the
// production shape, since the app sits behind a reverse proxy and keys its
// limiters on the forwarded address. Turning TRUST_PROXY on in the shared
// server would change rate-limit keying for every other spec.
const { test, expect, guardFixedPortSpec, _waitPortFree } = require("./isolated-test");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { PORT_BASE } = require("./helpers");
const { readySpawnedServer } = require("./spawned-server");

const VENUE_IP = "203.0.113.77";   // the room full of participants
const ADMIN_IP = "198.51.100.9";   // the organiser, working from elsewhere

// v8.8.19 — this spec binds a fixed SPAWNER_OFFSETS port; see guardFixedPortSpec.
test.beforeEach(() => guardFixedPortSpec());

test.describe("Trusted networks, end to end (v7.16.6)", () => {
  test("a blocked venue raises an alert, and the documented remedy actually unblocks it", async () => {
    test.setTimeout(180_000);
    // Far outside the worker-slot range so a parallel worker's server cannot
    // collide with it.
    const port = PORT_BASE + 110;
    const BASE = `http://localhost:${port}`;
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ipban-e2e-"));
    const spawnedAt = Date.now();
    const child = spawn(process.execPath, [path.resolve(__dirname, "..", "server.js")], {
      env: {
        PATH: process.env.PATH, HOME: process.env.HOME,
        PORT: String(port), BASE_URL: BASE, DATA_DIR: dataDir, UPLOADS_DIR: `${dataDir}/uploads`,
        TRUST_PROXY: "1",
        SMTP_HOST: "127.0.0.1", SMTP_PORT: "1026", SMTP_ALLOW_PLAINTEXT: "1",
        SUPERADMIN_PASSWORD_QUIET: "1", HSTS: "0", LOG_CONSOLE_MIRROR: "0",
        // v7.15.30 — a spawned server runs OUR node flags, never the runner's.
        NODE_OPTIONS: "",
        // NODE_ENV deliberately unset: production forces a Secure cookie and
        // express-session then refuses to emit one over plain HTTP, so there
        // would be no session at all. Rate limiting does not depend on it.
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let childOut = "";
    child.stdout.on("data", b => { childOut += b.toString(); });
    child.stderr.on("data", b => { childOut += b.toString(); });

    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    class Client {
      constructor(ip) { this.ip = ip; this.cookie = ""; this.csrf = ""; }
      async go(p, opts = {}) {
        const headers = { "x-forwarded-for": this.ip, "x-forwarded-proto": "https" };
        if (opts.body) headers["content-type"] = "application/json";
        const tok = opts.csrf ?? this.csrf;
        if (tok) headers["x-csrf-token"] = tok;
        if (this.cookie) headers["cookie"] = this.cookie;
        const r = await fetch(`${BASE}${p}`, {
          method: opts.method || "GET", headers,
          body: opts.body ? JSON.stringify(opts.body) : undefined,
        });
        const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
        if (sc.length) this.cookie = sc.map(c => c.split(";")[0]).join("; ");
        let json = null; try { json = await r.json(); } catch (_) {}
        return { status: r.status, json };
      }
      async refreshCsrf() { this.csrf = (await this.go("/api/csrf-token")).json?.csrfToken; return this.csrf; }
    }

    try {
      const pass = await readySpawnedServer({ base: BASE, child, dataDir, spawnedAt, output: () => childOut });

      // The organiser, on a DIFFERENT network from the venue.
      const admin = new Client(ADMIN_IP);
      await admin.refreshCsrf();
      const li = await admin.go("/api/login", { method: "POST", body: { email: "superadmin", password: pass } });
      expect(li.status, "admin signs in").toBe(200);
      await admin.refreshCsrf();

      const mk = await admin.go("/api/admin/competitions", {
        method: "POST",
        body: {
          name: `Venue Day ${Date.now()}`,
          start_time: new Date(Date.now() - 5 * 60_000).toISOString(),
          duration_minutes: 240,
        },
      });
      expect(mk.status, "a competition is live for the venue to be attending").toBe(200);
      const comp = mk.json.competition;

      // The venue trips the reputation tracker. Unauthenticated admin requests
      // return 401, which is a non-429 4xx and therefore countable — and this
      // is realistic: expired sessions polling from a roomful of browsers
      // produce exactly this shape.
      const venue = new Client(VENUE_IP);
      let blockedAt = 0;
      for (let i = 1; i <= 140 && !blockedAt; i++) {
        if ((await venue.go("/api/admin/participants")).status === 429) blockedAt = i;
      }
      expect(blockedAt, "the venue address is blocked by the scanner tracker").toBeGreaterThan(0);
      expect((await venue.go("/api/config")).status,
        "and the block covers the WHOLE address, not just the endpoint that tripped it").toBe(429);

      // The alert reaches the admin, who is not on the blocked network.
      let alert = null;
      for (let i = 0; i < 12 && !alert; i++) {
        const a = await admin.go("/api/admin/alerts");
        alert = (a.json?.alerts || []).find(x => x.ip === VENUE_IP);
        if (!alert) await sleep(300);
      }
      expect(alert, "an alert is raised for the blocked address").toBeTruthy();
      expect(alert.competition_name,
        "it names the live competition, so the admin knows where to act").toBe(comp.name);
      expect(alert.already_trusted,
        "it reports the address is not already trusted — otherwise its advice would be wrong").toBe(false);

      // The admin does exactly what the alert tells them to.
      const list = await admin.go("/api/admin/competitions");
      const row = ((list.json?.competitions || list.json) || []).find(c => c.id === comp.id);
      await admin.refreshCsrf();
      const save = await admin.go(`/api/admin/competitions/${comp.id}`, {
        method: "PUT", body: { trusted_network_ips: VENUE_IP, expectedUpdatedAt: row?.updated_at },
      });
      expect(save.status, `add the venue address as a trusted network: ${JSON.stringify(save.json)}`).toBe(200);

      // The promise the alert makes, in its own words.
      expect((await venue.go("/api/config")).status,
        "the block is lifted IMMEDIATELY on save — the alert's own promise").toBe(200);

      // …and prove the BLOCK ITSELF was released, not merely bypassed. Once the
      // address is allowlisted the scanner middleware short-circuits before it
      // ever consults the block, so the check above passes either way —
      // confirmed by disabling clearScannerBlocksFor, which it did not notice.
      // The audit event is where the difference is observable, and it is the
      // only place: `blocks_released` counts the addresses actually freed.
      const evs = await admin.go(`/api/admin/competitions/${comp.id}/events`);
      const changed = ((evs.json?.events || evs.json || []))
        .filter(e => e.event_type === "trusted_networks_changed")
        .map(e => (typeof e.details === "string" ? JSON.parse(e.details) : e.details) || {});
      expect(changed.length, "the change is audited").toBeGreaterThan(0);
      expect(changed.some(d => (d.blocks_released || 0) > 0),
        "saving a trusted network must RELEASE the block it covers, not just bypass it — otherwise " +
        "the address stays blocked for anything the allowlist does not cover"
      ).toBe(true);

      // …and the venue is genuinely exempt from the cap that caused all this.
      let venueThrottled = 0;
      for (let i = 0; i < 140; i++) if ((await venue.go("/api/csrf-token")).status === 429) venueThrottled++;
      expect(venueThrottled,
        "the venue is exempt from the per-IP cap (140 requests against a 120/min ceiling)").toBe(0);

      // The negative control, and the reason this test is worth its runtime: an
      // UNTRUSTED address must still be policed. Without it, every assertion
      // above is equally satisfied by rate limiting being switched off.
      const stranger = new Client("192.0.2.44");
      let strangerThrottled = 0;
      for (let i = 0; i < 140; i++) if ((await stranger.go("/api/csrf-token")).status === 429) strangerThrottled++;
      expect(strangerThrottled,
        "an untrusted address is still rate-limited — the bypass is scoped, not a global off-switch"
      ).toBeGreaterThan(0);
    } finally {
      child.kill("SIGKILL");
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  // v7.21.7 — the CREATE path. This must live here, not in
  // trusted-networks.api.spec.js, and the reason is structural: the defect is
  // that the SERVER PROCESS's cache is stale. The in-process spec calls
  // competitionAllowlistMatch in the TEST process against a second SQLite
  // connection, and it already calls invalidateCompAllowlist() by hand after
  // every mkComp — which is exactly the workaround that masked this for so long.
  // A test there cannot observe the server's cache at all. The existing e2e test
  // above sets the IPs via PUT, which is why it always passed.
  test("v7.21.7: a competition CREATED with trusted IPs exempts that address with no later edit", async () => {
    test.setTimeout(180_000);
    const port = PORT_BASE + 111;   // distinct from the test above, so both can share a worker
    const BASE = `http://localhost:${port}`;
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ipban-create-"));
    const spawnedAt = Date.now();
    const child = spawn(process.execPath, [path.resolve(__dirname, "..", "server.js")], {
      env: {
        PATH: process.env.PATH, HOME: process.env.HOME,
        PORT: String(port), BASE_URL: BASE, DATA_DIR: dataDir, UPLOADS_DIR: `${dataDir}/uploads`,
        TRUST_PROXY: "1",
        SMTP_HOST: "127.0.0.1", SMTP_PORT: "1026", SMTP_ALLOW_PLAINTEXT: "1",
        SUPERADMIN_PASSWORD_QUIET: "1", HSTS: "0", LOG_CONSOLE_MIRROR: "0",
        NODE_OPTIONS: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let childOut = "";
    child.stdout.on("data", b => { childOut += b.toString(); });
    child.stderr.on("data", b => { childOut += b.toString(); });
    class C {
      constructor(ip) { this.ip = ip; this.cookie = ""; this.csrf = ""; }
      async go(p, opts = {}) {
        const headers = { "x-forwarded-for": this.ip, "x-forwarded-proto": "https" };
        if (opts.body) headers["content-type"] = "application/json";
        if (this.csrf) headers["x-csrf-token"] = this.csrf;
        if (this.cookie) headers["cookie"] = this.cookie;
        const r = await fetch(`${BASE}${p}`, {
          method: opts.method || "GET", headers,
          body: opts.body ? JSON.stringify(opts.body) : undefined,
        });
        const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
        if (sc.length) this.cookie = sc.map(c => c.split(";")[0]).join("; ");
        let json = null; try { json = await r.json(); } catch (_) {}
        return { status: r.status, json };
      }
      async refreshCsrf() { this.csrf = (await this.go("/api/csrf-token")).json?.csrfToken; return this.csrf; }
    }

    try {
      const pass = await readySpawnedServer({ base: BASE, child, dataDir, spawnedAt, output: () => childOut });

      const admin = new C(ADMIN_IP);
      await admin.refreshCsrf();
      expect((await admin.go("/api/login", { method: "POST", body: { email: "superadmin", password: pass } })).status).toBe(200);
      await admin.refreshCsrf();

      // LOAD-BEARING SETUP: warm the server's cache from a DIFFERENT address
      // BEFORE the create. Without this the create could be the first request
      // and the lazy build would pick the row up anyway — the test would pass
      // against unfixed code.
      for (let i = 0; i < 5; i++) await admin.go("/api/config");

      // Trusted IPs supplied IN THE CREATE BODY. No PUT anywhere in this test.
      const mk = await admin.go("/api/admin/competitions", {
        method: "POST",
        body: {
          name: `Created Trusted ${Date.now()}`,
          start_time: new Date(Date.now() - 5 * 60_000).toISOString(),
          duration_minutes: 240,
          trusted_network_ips: VENUE_IP,
        },
      });
      expect(mk.status, `create with trusted IPs: ${JSON.stringify(mk.json)}`).toBe(200);

      // The venue drives well past the 120/min /api/csrf-token ceiling.
      const venue = new C(VENUE_IP);
      let venueThrottled = 0;
      for (let i = 0; i < 140; i++) if ((await venue.go("/api/csrf-token")).status === 429) venueThrottled++;
      expect(venueThrottled,
        "a competition CREATED with the venue's address must exempt it immediately — the cache " +
        "is built by the first request the process handles, so without an explicit invalidation " +
        "the address entered on the New Competition form is never in the allowlist at all"
      ).toBe(0);

      // NEGATIVE CONTROL, mandatory (v7.16.6): every assertion above is equally
      // satisfied by rate limiting being switched off.
      const stranger = new C("192.0.2.55");
      let strangerThrottled = 0;
      for (let i = 0; i < 140; i++) if ((await stranger.go("/api/csrf-token")).status === 429) strangerThrottled++;
      expect(strangerThrottled,
        "an untrusted address is still rate-limited — the bypass is scoped, not a global off-switch"
      ).toBeGreaterThan(0);
    } finally {
      child.kill("SIGKILL");
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  // USE MY CURRENT ADDRESS, end to end. The organiser stands in the room, behind
  // the same proxy as everyone else, which writes the venue's address into
  // X-Forwarded-For — here in the IPv4-mapped form a dual-stack proxy writes.
  // GET /api/admin/my-address must answer the CANONICAL address and its range
  // for every form a proxy can write, and the address it answers, saved as the
  // event's trusted network, must be the one the limiter then exempts. Only a
  // TRUST_PROXY server sees forwarded addresses at all, hence this file. The
  // port is this file's own first one, used again once the server that held it
  // has gone.
  test("Use my current address: the organiser in the room reads the venue's canonical address, and saving it exempts the room", async () => {
    test.setTimeout(180_000);
    const port = PORT_BASE + 110;
    const BASE = `http://localhost:${port}`;
    await _waitPortFree(port);
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ipban-mine-"));
    const spawnedAt = Date.now();
    const child = spawn(process.execPath, [path.resolve(__dirname, "..", "server.js")], {
      env: {
        PATH: process.env.PATH, HOME: process.env.HOME,
        PORT: String(port), BASE_URL: BASE, DATA_DIR: dataDir, UPLOADS_DIR: `${dataDir}/uploads`,
        TRUST_PROXY: "1",
        SMTP_HOST: "127.0.0.1", SMTP_PORT: "1026", SMTP_ALLOW_PLAINTEXT: "1",
        SUPERADMIN_PASSWORD_QUIET: "1", HSTS: "0", LOG_CONSOLE_MIRROR: "0",
        NODE_OPTIONS: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const exited = new Promise(r => child.once("close", r));
    let childOut = "";
    child.stdout.on("data", b => { childOut += b.toString(); });
    child.stderr.on("data", b => { childOut += b.toString(); });
    class C {
      constructor(ip) { this.ip = ip; this.cookie = ""; this.csrf = ""; }
      async go(p, opts = {}) {
        const headers = { "x-forwarded-for": this.ip, "x-forwarded-proto": "https" };
        if (opts.body) headers["content-type"] = "application/json";
        if (this.csrf) headers["x-csrf-token"] = this.csrf;
        if (this.cookie) headers["cookie"] = this.cookie;
        const r = await fetch(`${BASE}${p}`, {
          method: opts.method || "GET", headers,
          body: opts.body ? JSON.stringify(opts.body) : undefined,
        });
        const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
        if (sc.length) this.cookie = sc.map(c => c.split(";")[0]).join("; ");
        let json = null; try { json = await r.json(); } catch (_) {}
        return { status: r.status, json, cacheControl: r.headers.get("cache-control") };
      }
      async refreshCsrf() { this.csrf = (await this.go("/api/csrf-token")).json?.csrfToken; return this.csrf; }
    }
    const ROOM = "203.0.113.88";
    const ROOM_MAPPED = `::ffff:${ROOM}`;

    try {
      const pass = await readySpawnedServer({ base: BASE, child, dataDir, spawnedAt, output: () => childOut });

      // Anonymous, whatever the address: no session, no answer.
      const anon = await new C(ROOM_MAPPED).go("/api/admin/my-address");
      expect(anon.status).toBe(401);
      expect(anon.json).toEqual({ error: "Not authenticated" });

      const organiser = new C(ROOM_MAPPED);
      await organiser.refreshCsrf();
      expect((await organiser.go("/api/login", { method: "POST", body: { email: "superadmin", password: pass } })).status).toBe(200);
      await organiser.refreshCsrf();

      const mine = await organiser.go("/api/admin/my-address");
      expect(mine.status, JSON.stringify(mine.json)).toBe(200);
      expect(mine.json, "the mapped form a dual-stack proxy writes is answered as the IPv4 address it is")
        .toEqual({ ip: ROOM, range: "public" });
      expect(mine.cacheControl).toBe("no-store");

      // Every form a proxy can write, read through the same session: canonical,
      // and each range named.
      const FORMS = [
        ["2001:0DB8:0000:0000:0000:0000:0000:0001", { ip: "2001:db8::1", range: "public" }],
        ["198.51.100.9", { ip: "198.51.100.9", range: "public" }],
        ["10.20.30.40", { ip: "10.20.30.40", range: "private" }],
        ["::ffff:192.168.7.8", { ip: "192.168.7.8", range: "private" }],
        ["127.0.0.1", { ip: "127.0.0.1", range: "loopback" }],
        ["fe80::1", { ip: "fe80::1", range: "link_local" }],
        ["100.64.1.2", { ip: "100.64.1.2", range: "shared" }],
      ];
      for (const [form, want] of FORMS) {
        organiser.ip = form;
        const got = await organiser.go("/api/admin/my-address");
        expect({ status: got.status, body: got.json }, `forwarded as ${form}`).toEqual({ status: 200, body: want });
      }
      organiser.ip = ROOM_MAPPED;

      // The remedy, with exactly what the button would add: the room is exempt.
      const mk = await organiser.go("/api/admin/competitions", {
        method: "POST",
        body: {
          name: `Room address ${Date.now()}`,
          start_time: new Date(Date.now() - 5 * 60_000).toISOString(),
          duration_minutes: 240,
          trusted_network_ips: mine.json.ip,
        },
      });
      expect(mk.status, `create with the address the organiser read: ${JSON.stringify(mk.json)}`).toBe(200);

      const room = new C(ROOM_MAPPED);
      let roomThrottled = 0;
      for (let i = 0; i < 140; i++) if ((await room.go("/api/csrf-token")).status === 429) roomThrottled++;
      expect(roomThrottled, "the room, arriving in the mapped form, is exempt under the address the organiser was given").toBe(0);

      // NEGATIVE CONTROL: an address nobody saved is still policed.
      const stranger = new C("192.0.2.56");
      let strangerThrottled = 0;
      for (let i = 0; i < 140; i++) if ((await stranger.go("/api/csrf-token")).status === 429) strangerThrottled++;
      expect(strangerThrottled, "an untrusted address is still rate-limited").toBeGreaterThan(0);
    } finally {
      child.kill("SIGKILL");
      await exited;
      await _waitPortFree(port).catch(() => {});
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
