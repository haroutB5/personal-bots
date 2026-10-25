// Minimal stand-in for the real server: writes server-runtime.json, serves the
// environment endpoint, and exits on SIGTERM. Used only by tests.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const args = process.argv.slice(2);
const valueOf = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
};
const baseDir = valueOf("--base-dir");
const port = Number(valueOf("--port") || 0);
if (!baseDir) {
  console.error("fake server: --base-dir is required");
  process.exit(2);
}
fs.mkdirSync(path.join(baseDir, "userdata"), { recursive: true });

const server = http.createServer((request, response) => {
  if (request.url?.startsWith("/.well-known/t3/environment")) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ serverVersion: "fake-0.0.1" }));
    return;
  }
  response.writeHead(404);
  response.end("not found");
});

server.listen(port, "127.0.0.1", () => {
  const actual = server.address().port;
  fs.writeFileSync(
    path.join(baseDir, "userdata", "server-runtime.json"),
    JSON.stringify({ origin: `http://127.0.0.1:${actual}`, startedAt: new Date().toISOString(), pid: process.pid }),
  );
  console.log(`fake server listening on ${actual}`);
});

const shutdown = () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
