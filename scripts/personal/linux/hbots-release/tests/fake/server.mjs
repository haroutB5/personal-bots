// Stand-in for the hbots server in the release-runner fixture. Copied to <release>/dist/bin.mjs; run as
//   node <release>/dist/bin.mjs serve        (by a throwaway systemd user unit)
// It writes run/server.json like the real server, logs the startup markers the runner checks, and answers the
// HTTP probes. It never touches a database.
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";

const self = NodeURL.fileURLToPath(import.meta.url);
const releaseDir = NodePath.dirname(NodePath.dirname(self));
const version = /^version=(.+)$/m.exec(
  NodeFS.readFileSync(NodePath.join(releaseDir, "VERSION"), "utf8"),
)[1];
const release = NodePath.basename(releaseDir);
const home = process.env.FIXTURE_HOME;
const port = Number(process.env.FIXTURE_PORT);
const logFile = NodePath.join(home, "logs", "server-fixture.log");
NodeFS.mkdirSync(NodePath.dirname(logFile), { recursive: true });
const log = (line) => NodeFS.appendFileSync(logFile, `${line}\n`);
const flag = (name) => NodeFS.existsSync(NodePath.join(releaseDir, name));

log(`=== ${new Date().toISOString()} serve release ${release} version ${version}`);
log("stall recorder on { profiler: 'continuous' }");
log("claude sdk warning filter installed");
if (flag("MIGRATES")) {
  log("Migrations ran successfully");
  log("migrations: ['114_fixture_change']");
}
if (flag("BAD_LOG")) log("ERROR fixture: something went wrong at startup");

const server = NodeHttp.createServer((req, res) => {
  if (req.url === "/version.txt") return res.end(`version=${version}\nrelease=${release}\n`);
  if (req.url === "/sw.js") return res.end("const REVISION = '2026-09-30-worker-list';");
  if (req.url === "/.well-known/t3/environment")
    return res.end(JSON.stringify({ version: "fixture" }));
  if (req.url === "/api/personal/push/sent" && req.method === "POST") {
    res.statusCode = 401;
    return res.end("unauthorized");
  }
  res.statusCode = 404;
  res.end("not found");
});
server.listen(port, "127.0.0.1", () => {
  NodeFS.mkdirSync(NodePath.join(home, "run"), { recursive: true });
  const state = {
    pid: process.pid,
    release,
    version,
    binPath: self,
    logFile,
    startedAt: new Date().toISOString(),
    port,
  };
  const file = NodePath.join(home, "run", "server.json");
  NodeFS.writeFileSync(`${file}.tmp`, JSON.stringify(state));
  NodeFS.renameSync(`${file}.tmp`, file);
  // Tests: one long-lived child inside the unit's own cgroup, so the release
  // runner's "only the server cgroup counts" rule can be proven both ways.
  if (process.env.FIXTURE_CHILD) {
    const child = NodeChildProcess.spawn(process.env.FIXTURE_CHILD, {
      shell: true,
      stdio: "ignore",
    });
    NodeFS.writeFileSync(NodePath.join(home, "run", "fixture-child.pid"), `${child.pid}\n`);
  }
});
process.on("SIGTERM", () => process.exit(0));
