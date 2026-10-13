// Tiny HTTP CONNECT proxy that logs every destination host:port, then tunnels. Usage: node connect-logger.mjs <port> <logfile>
import http from "node:http";
import net from "node:net";
import { appendFileSync } from "node:fs";
const [port, log] = [Number(process.argv[2]), process.argv[3]];
const server = http.createServer((req, res) => {
  appendFileSync(log, JSON.stringify({ t: Date.now(), kind: "http", url: req.url }) + "\n");
  res.writeHead(502).end();
});
server.on("connect", (req, sock, head) => {
  appendFileSync(log, JSON.stringify({ t: Date.now(), kind: "connect", host: req.url }) + "\n");
  const [h, p] = req.url.split(":");
  const up = net.connect(Number(p || 443), h, () => {
    sock.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    up.write(head);
    up.pipe(sock);
    sock.pipe(up);
  });
  up.on("error", () => sock.destroy());
  sock.on("error", () => up.destroy());
});
server.listen(port, "127.0.0.1", () => console.log("listening", port));
