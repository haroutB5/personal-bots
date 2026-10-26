// Stand-in for the hbots server in the release-runner fixture. Copied to <release>/dist/bin.mjs; run as
//   node <release>/dist/bin.mjs serve        (by a throwaway systemd user unit)
// It writes run/server.json like the real server, logs the startup markers the runner checks, and answers the
// HTTP probes. It never touches a database.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const self = fileURLToPath(import.meta.url);
const releaseDir = path.dirname(path.dirname(self));
const version = /^version=(.+)$/m.exec(fs.readFileSync(path.join(releaseDir, "VERSION"), "utf8"))[1];
const release = path.basename(releaseDir);
const home = process.env.FIXTURE_HOME;
const port = Number(process.env.FIXTURE_PORT);
const logFile = path.join(home, "logs", "server-fixture.log");
fs.mkdirSync(path.dirname(logFile), { recursive: true });
const log = (line) => fs.appendFileSync(logFile, `${line}\n`);
const flag = (name) => fs.existsSync(path.join(releaseDir, name));

log(`=== ${new Date().toISOString()} serve release ${release} version ${version}`);
log("stall recorder on { profiler: 'continuous' }");
if (flag("MIGRATES")) {
  log("Migrations ran successfully");
  log("migrations: ['114_fixture_change']");
}
if (flag("BAD_LOG")) log("ERROR fixture: something went wrong at startup");

const server = http.createServer((req, res) => {
  if (req.url === "/version.txt") return res.end(`version=${version}\nrelease=${release}\n`);
  if (req.url === "/sw.js") return res.end("const REVISION = '2026-09-30-worker-list';");
  if (req.url === "/.well-known/t3/environment") return res.end(JSON.stringify({ version: "fixture" }));
  if (req.url === "/api/personal/push/sent" && req.method === "POST") {
    res.statusCode = 401;
    return res.end("unauthorized");
  }
  res.statusCode = 404;
  res.end("not found");
});
server.listen(port, "127.0.0.1", () => {
  fs.mkdirSync(path.join(home, "run"), { recursive: true });
  const state = { pid: process.pid, release, version, binPath: self, logFile, startedAt: new Date().toISOString(), port };
  const file = path.join(home, "run", "server.json");
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(state));
  fs.renameSync(`${file}.tmp`, file);
});
process.on("SIGTERM", () => process.exit(0));
