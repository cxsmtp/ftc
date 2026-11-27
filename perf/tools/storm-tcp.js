// Fed to `node -` inside the app container: one JSON line describing the
// listening socket's accept queue and how many established sockets hold unread
// bytes (data the process has not read yet). Read from /proc/net/tcp{,6}.
const fs = require("fs");
const PORT_HEX = (parseInt(process.env.PORT || "3000", 10)).toString(16).toUpperCase().padStart(4, "0");
const out = { t: Date.now(), listenQueue: 0, listenMax: 0, estab: 0, estabUnread: 0, unreadBytes: 0, synRecv: 0, timeWait: 0, closeWait: 0 };
for (const f of ["/proc/net/tcp", "/proc/net/tcp6"]) {
  let txt = ""; try { txt = fs.readFileSync(f, "utf8"); } catch (_) { continue; }
  for (const line of txt.split("\n").slice(1)) {
    const p = line.trim().split(/\s+/); if (p.length < 5) continue;
    const local = p[1], st = p[3], [, rx] = p[4].split(":").map(h => parseInt(h, 16));
    const [tx] = p[4].split(":").map(h => parseInt(h, 16));
    if (!local.endsWith(":" + PORT_HEX)) continue;
    if (st === "0A") { out.listenQueue += rx; out.listenMax += tx; }        // LISTEN: rx = queue, tx = backlog
    else if (st === "01") { out.estab++; if (rx > 0) { out.estabUnread++; out.unreadBytes += rx; } }
    else if (st === "03") out.synRecv++;
    else if (st === "06") out.timeWait++;
    else if (st === "08") out.closeWait++;
  }
}
console.log(JSON.stringify(out));
