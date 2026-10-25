import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { getPaths } from "../lib/paths.mjs";
import { startServer, stopServer, restartServer, describeStatus, serveForeground } from "../lib/server.mjs";
import { runSmoke } from "../lib/smoke.mjs";
import * as proc from "../lib/proc.mjs";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hbots-life-"));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function makeRelease(paths, name = "r1") {
  const dir = path.join(paths.releasesDir, name);
  fs.mkdirSync(path.join(dir, "dist"), { recursive: true });
  fs.mkdirSync(path.join(dir, "node_modules"), { recursive: true });
  fs.copyFileSync(path.join(fixtures, "fake-server.mjs"), path.join(dir, "dist", "bin.mjs"));
  fs.writeFileSync(path.join(dir, "VERSION"), `version=0.0.1\nrelease=${name}\n`);
  fs.writeFileSync(paths.currentFile, `${name}\n`);
  return dir;
}

test("start, status, smoke and stop against a throwaway root", async () => {
  const home = tempHome();
  const repoRoot = tempHome();
  const paths = getPaths({ home });
  fs.mkdirSync(paths.releasesDir, { recursive: true });
  makeRelease(paths);
  const port = await freePort();

  const started = await startServer({ paths, repoRoot, nodeExe: process.execPath, port, waitMs: 20000 });
  try {
    assert.equal(started.alreadyRunning, false);
    assert.equal(started.ready, true);
    assert.equal(proc.isServerProcess(started.state.pid, started.state), true);

    const status = describeStatus({ paths });
    assert.equal(status.alive, true);
    assert.equal(status.active, "r1");
    assert.equal(status.version.version, "0.0.1");

    const smoke = await runSmoke({
      paths,
      expectRelease: "r1",
      startTimeoutSeconds: 10,
      stableSeconds: 1,
      noTunnel: true,
      nodeExe: process.execPath,
    });
    assert.equal(smoke.ok, true, smoke.lines.join("\n"));

    const wrong = await runSmoke({
      paths,
      expectRelease: "other",
      startTimeoutSeconds: 1,
      stableSeconds: 1,
      noTunnel: true,
      nodeExe: process.execPath,
    });
    assert.equal(wrong.ok, false);
  } finally {
    const stopped = await stopServer({ paths });
    assert.equal(stopped.stopped, true);
  }
  assert.equal(proc.isAlive(started.state.pid), false);
  assert.equal(fs.existsSync(paths.stateFile), false);
});

test("smoke fails when the log has SQL errors", async () => {
  const home = tempHome();
  const repoRoot = tempHome();
  const paths = getPaths({ home });
  fs.mkdirSync(paths.releasesDir, { recursive: true });
  fs.mkdirSync(paths.logsDir, { recursive: true });
  makeRelease(paths);
  const port = await freePort();
  const started = await startServer({ paths, repoRoot, nodeExe: process.execPath, port, waitMs: 20000 });
  try {
    const logFile = path.join(paths.logsDir, "server-20990101.log");
    fs.writeFileSync(logFile, "SQLITE_ERROR: no such column: x\n");
    const smoke = await runSmoke({
      paths,
      expectRelease: "r1",
      startTimeoutSeconds: 5,
      stableSeconds: 1,
      noTunnel: true,
      logFile,
      nodeExe: process.execPath,
    });
    assert.equal(smoke.ok, false);
    assert.match(smoke.lines.join("\n"), /SQL error line/);
  } finally {
    await stopServer({ paths });
  }
  assert.equal(proc.isAlive(started.state.pid), false);
});

test("stop refuses a PID whose command line is not the recorded server", async () => {
  const home = tempHome();
  const paths = getPaths({ home });
  fs.mkdirSync(paths.runDir, { recursive: true });
  proc.writeState(paths, {
    pid: process.pid,
    root: "dev",
    baseDir: paths.baseDir,
    binPath: path.join(home, "not-the-server.mjs"),
    release: "r1",
  });
  await assert.rejects(() => stopServer({ paths }), /Refusing to kill it/);
  assert.equal(proc.isAlive(process.pid), true);
});

test("restart keeps the same release and a live pid", async () => {
  const home = tempHome();
  const repoRoot = tempHome();
  const paths = getPaths({ home });
  fs.mkdirSync(paths.releasesDir, { recursive: true });
  makeRelease(paths, "r1");
  makeRelease(paths, "r2");
  const port = await freePort();
  const first = await startServer({ paths, repoRoot, nodeExe: process.execPath, port, waitMs: 20000 });
  try {
    const restarted = await restartServer({ paths, repoRoot, releaseName: "r2", viaSystemd: false, keepReleases: 0, nodeExe: process.execPath, port });
    assert.equal(restarted.state.release, "r2");
    assert.notEqual(restarted.state.pid, first.state.pid);
    assert.equal(proc.isServerProcess(restarted.state.pid, restarted.state), true);
  } finally {
    await stopServer({ paths });
  }
});

test("serve (systemd foreground) writes state and exits on SIGTERM", async () => {
  const home = tempHome();
  const repoRoot = tempHome();
  const paths = getPaths({ home });
  fs.mkdirSync(paths.releasesDir, { recursive: true });
  makeRelease(paths, "r1");
  const port = await freePort();
  const runner = serveForeground({ paths, repoRoot, nodeExe: process.execPath, port });
  const deadline = Date.now() + 15000;
  let state = null;
  while (Date.now() < deadline) {
    state = proc.readState(paths);
    if (state && proc.isServerProcess(Number(state.pid), state)) break;
    await proc.sleep(200);
  }
  assert.ok(state, "state written");
  const childPid = Number(state.pid);
  process.emit("SIGTERM");
  const code = await runner;
  assert.equal(code, 0);
  assert.equal(proc.isAlive(childPid), false);
});
