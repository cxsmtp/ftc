#!/usr/bin/env node
/**
 * v7.15.33 — a minimal SMTP sink for local perf runs.
 *
 * The perf protocol requires SMTP_HOST to point at a capture server, never a
 * real MTA. mailpit/smtp4dev are the documented choices, but for an automated
 * local run we do not want to require a container pull just to swallow a
 * handful of competition-assignment notifications.
 *
 * This accepts a connection, speaks just enough SMTP to make nodemailer happy,
 * and throws the message away. It counts what it swallowed so the run summary
 * can report it — a sudden jump in mail volume is itself a useful signal.
 *
 * It is deliberately PLAINTEXT (no STARTTLS), which since v7.15.12 means the
 * server must run with SMTP_ALLOW_PLAINTEXT=1. That flag is the documented
 * development opt-out and run-local.sh sets it; never set it on a real target.
 */
const net = require("net");

const PORT = parseInt(process.env.SINK_PORT || "1025", 10);
const HOST = process.env.SINK_HOST || "127.0.0.1";
let accepted = 0;

const server = net.createServer((sock) => {
  let inData = false;
  let buf = "";
  sock.setEncoding("utf8");
  sock.write("220 perf-smtp-sink ESMTP\r\n");

  sock.on("data", (chunk) => {
    buf += chunk;
    for (;;) {
      if (inData) {
        // Body ends at a lone dot on its own line.
        const end = buf.indexOf("\r\n.\r\n");
        if (end === -1) return;
        buf = buf.slice(end + 5);
        inData = false;
        accepted++;
        sock.write("250 2.0.0 Ok: queued\r\n");
        continue;
      }
      const nl = buf.indexOf("\r\n");
      if (nl === -1) return;
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 2);
      const verb = line.slice(0, 4).toUpperCase();
      if (verb === "EHLO") {
        // No STARTTLS advertised — that is the point of the sink, and it is
        // why the server needs SMTP_ALLOW_PLAINTEXT=1 to talk to it.
        sock.write("250-perf-smtp-sink\r\n250-8BITMIME\r\n250 SIZE 52428800\r\n");
      } else if (verb === "HELO") {
        sock.write("250 perf-smtp-sink\r\n");
      } else if (verb === "MAIL" || verb === "RCPT" || verb === "RSET" || verb === "NOOP") {
        sock.write("250 2.0.0 Ok\r\n");
      } else if (verb === "DATA") {
        inData = true;
        sock.write("354 End data with <CR><LF>.<CR><LF>\r\n");
      } else if (verb === "QUIT") {
        sock.write("221 2.0.0 Bye\r\n");
        sock.end();
        return;
      } else if (verb === "AUTH") {
        sock.write("235 2.7.0 Accepted\r\n");
      } else {
        sock.write("250 2.0.0 Ok\r\n");
      }
    }
  });
  sock.on("error", () => { /* a client hanging up mid-send is normal here */ });
});

server.on("error", (e) => {
  console.error(`[smtp-sink] cannot listen on ${HOST}:${PORT}: ${e.message}`);
  process.exit(1);
});

server.listen(PORT, HOST, () => console.log(`[smtp-sink] listening on ${HOST}:${PORT}`));

function bye() {
  console.log(`[smtp-sink] swallowed ${accepted} message(s)`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref();
}
process.on("SIGTERM", bye);
process.on("SIGINT", bye);
