#!/usr/bin/env node
// Fresh-root throwaway hbots server for tests (the Linux twin of
// scripts/personal/throwaway-server.ps1).
//
//   throwaway.mjs start --name <n> --release <folder|worktree|sha12> [--port] [--json]
//   throwaway.mjs stop  --name <n>      stop the recorded server, delete its root
//   throwaway.mjs pair  --name <n>      print a fresh single-use pairing link
//   throwaway.mjs down  --name <n>      stop the recorded server, keep the root
//   throwaway.mjs up    --name <n>      start that root again on the same port
//   throwaway.mjs list                  the throwaway roots and whether they run
//
// A fake Claude CLI is installed in the root (never a real account), the seed
// model is Sonnet 5.5, every provider home points inside the root, and the
// server listens on 127.0.0.1 only. Each root is `hbots-tw-<name>-<8 hex>`:
// the random suffix keeps the path unpredictable, and later commands find it
// through the record inside it. PIDs are only touched after
// /proc/<pid>/cmdline still names the recorded binary and root.
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";
import { randomBytes } from "node:crypto";

import * as proc from "./lib/proc.mjs";
import { getPaths } from "./lib/paths.mjs";

const HERE = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
export const ROOT_PREFIX = "hbots-tw-";
/** Four random bytes (eight hex characters): enough that a root cannot be guessed. */
const ROOT_RANDOM_BYTES = 4;
const RECORD = "throwaway.json";
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,30}$/;
const FAKE_SOURCE = NodePath.join(HERE, "..", "testing", "fake-claude");

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      if (key === "json" || key === "schedulers-off") out[key] = true;
      else out[key] = argv[(i += 1)];
    } else out._.push(arg);
  }
  return out;
}

function assertName(name) {
  if (!NAME_PATTERN.test(name ?? "")) {
    throw new Error(
      `Name '${name}' must be 1 to 31 characters: lower-case letters, digits and dashes, starting with a letter or digit.`,
    );
  }
}

/**
 * A fresh root the caller cannot predict. The name stays readable
 * (`hbots-tw-<name>-<8 hex>`); the suffix is what stops another process from
 * planting a symlink at the path between our check and our `mkdir`.
 */
export function randomRoot(name) {
  assertName(name);
  return NodePath.join(
    NodeOS.tmpdir(),
    `${ROOT_PREFIX}${name}-${randomBytes(ROOT_RANDOM_BYTES).toString("hex")}`,
  );
}

/**
 * Why a folder may not be an owned throwaway root, or null when it may. A
 * record alone proves nothing: any process can create `/tmp/hbots-tw-<name>-*`
 * with a JSON file in it, and before 1.66.101 `stop` believed it and killed the
 * PIDs it named. Only the owner's own 0700 folder, not a symlink, is trusted.
 */
export function rootRejection(root) {
  let stats;
  try {
    stats = NodeFS.lstatSync(root);
  } catch {
    return "it is gone";
  }
  if (stats.isSymbolicLink()) return "it is a symlink";
  if (!stats.isDirectory()) return "it is not a folder";
  if (typeof process.getuid === "function" && stats.uid !== process.getuid()) {
    return "another user owns it";
  }
  const mode = stats.mode & 0o777;
  return mode === 0o700 ? null : `its mode is 0${mode.toString(8)}`;
}

const rootRecordMatches = (root, record) =>
  record !== undefined &&
  record !== null &&
  typeof record.root === "string" &&
  NodePath.resolve(record.root) === NodePath.resolve(root);

/** The folder a name matches by its record, trusted or not. `stop` explains a refusal. */
export function foundRootFor(name) {
  assertName(name);
  const prefix = `${ROOT_PREFIX}${name}-`;
  let entries;
  try {
    entries = NodeFS.readdirSync(NodeOS.tmpdir());
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.startsWith(prefix)) continue;
    const root = NodePath.join(NodeOS.tmpdir(), entry);
    const record = readRecord(root);
    if (record?.name === name) return root;
  }
  return null;
}

/** The root this name currently owns, found by its record, never by guessing. */
export function existingRootFor(name) {
  const root = foundRootFor(name);
  if (root === null) return null;
  if (rootRejection(root) !== null) return null;
  if (!rootRecordMatches(root, readRecord(root))) return null;
  return root;
}

const readRecord = (root) => {
  try {
    return JSON.parse(NodeFS.readFileSync(NodePath.join(root, RECORD), "utf8"));
  } catch {
    return null;
  }
};
const writeRecord = (root, value) =>
  NodeFS.writeFileSync(NodePath.join(root, RECORD), `${JSON.stringify(value, null, 2)}\n`);

function resolveBin(where) {
  const bases = [where];
  if (/^[0-9a-f]{7,40}$/.test(where)) bases.push(NodePath.join(getPaths({}).releasesDir, where));
  for (const base of bases) {
    for (const relative of ["dist/bin.mjs", "apps/server/dist/bin.mjs"]) {
      const candidate = NodePath.resolve(base, relative);
      if (NodeFS.existsSync(candidate)) return candidate;
    }
  }
  throw new Error(
    `No dist/bin.mjs or apps/server/dist/bin.mjs under '${where}'. Pass a release folder, a built worktree or a sha12.`,
  );
}

const isRunning = (record) =>
  record !== null &&
  proc.isServerProcess(Number(record.pid), { binPath: record.bin, baseDir: record.root });

function freePort() {
  return new Promise((resolve, reject) => {
    const server = NodeNet.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function writeFakeClaude(root) {
  const nodeExe = process.execPath;
  for (const persona of ["fakeok", "fakelimit"]) {
    const dir = NodePath.join(root, "fake", persona);
    const pkg = NodePath.join(dir, "node_modules", "@anthropic-ai", "claude-code");
    NodeFS.mkdirSync(pkg, { recursive: true });
    NodeFS.copyFileSync(NodePath.join(FAKE_SOURCE, "cli.js"), NodePath.join(pkg, "cli.js"));
    NodeFS.copyFileSync(
      NodePath.join(FAKE_SOURCE, "package.json"),
      NodePath.join(pkg, "package.json"),
    );
    const launcher = NodePath.join(dir, "claude");
    NodeFS.writeFileSync(
      launcher,
      `#!/bin/sh\nexec ${JSON.stringify(nodeExe)} ${JSON.stringify(NodePath.join(pkg, "cli.js"))} "$@"\n`,
    );
    NodeFS.chmodSync(launcher, 0o755);
  }
}

function writeSettings(root) {
  const fake = (persona) => NodePath.join(root, "fake", persona, "claude");
  const home = (name) => NodePath.join(root, "homes", name);
  const settings = {
    providers: {
      claudeAgent: { binaryPath: fake("fakeok"), homePath: home("claude") },
      codex: { enabled: false, homePath: home("codex") },
      deepseek: { homePath: home("deepseek") },
      opencode: { enabled: false },
      cursor: { enabled: false },
      grok: { enabled: false },
    },
    providerInstances: {
      claudeLimited: {
        driver: "claudeAgent",
        displayName: "Home (limited)",
        config: { binaryPath: fake("fakelimit"), homePath: home("claude") },
      },
    },
  };
  NodeFS.mkdirSync(NodePath.join(root, "userdata"), { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(root, "userdata", "settings.json"),
    `${JSON.stringify(settings, null, 2)}\n`,
  );
}

function serverEnv(name, root, schedulersOff) {
  const env = {
    ...process.env,
    PERSONAL_SEED_MODEL: "claude-sonnet-5-5",
    FAKE_CLAUDE_PID_DIR: NodePath.join(root, "fake-pids"),
    T3CODE_PERSONAL_BROWSER_HEADLESS: "1",
    T3CODE_AUTO_CONNECT: "false",
    T3CODE_ENVIRONMENT_LABEL: `throwaway ${name}`,
    GROK_HOME: NodePath.join(root, "homes", "grok"),
    OPENCODE_DATA_DIR: NodePath.join(root, "homes", "opencode"),
    ANTIGRAVITY_DATA_DIR: NodePath.join(root, "homes", "antigravity"),
  };
  if (schedulersOff) env.T3CODE_PERSONAL_SCHEDULERS = "off";
  return env;
}

async function waitUp(origin, pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!proc.isAlive(pid)) return false;
    try {
      const response = await fetch(`${origin}/version.txt`, {
        signal: AbortSignal.timeout(2000),
      });
      if (response.ok) return true;
    } catch {
      // Not listening yet.
    }
    await proc.sleep(500);
  }
  return false;
}

function startServer({ name, root, bin, port, schedulersOff }) {
  NodeFS.mkdirSync(NodePath.join(root, "fake-pids"), { recursive: true });
  for (const home of ["claude", "codex", "deepseek", "grok", "opencode", "antigravity"]) {
    NodeFS.mkdirSync(NodePath.join(root, "homes", home), { recursive: true });
  }
  const logFile = NodePath.join(root, "server.log");
  const child = proc.spawnServe({
    nodeExe: process.execPath,
    binPath: bin,
    baseDir: root,
    logFile,
    workDir: root,
    port,
    env: serverEnv(name, root, schedulersOff),
    detached: true,
  });
  // The detached child leads its own process group; record it so stop still
  // reaches the fake CLIs and grandchildren after a crash killed the leader.
  return { pid: child.pid, pgid: proc.processGroupOf(child.pid), logFile };
}

function pairingLink(record) {
  const origin = `http://127.0.0.1:${record.port}`;
  const result = NodeChildProcess.spawnSync(
    process.execPath,
    [record.bin, "pair", "--base-dir", record.root],
    {
      encoding: "utf8",
      timeout: 60_000,
    },
  );
  const token = /^\s*Token:\s*(\S+)/m.exec(`${result.stdout}\n${result.stderr}`);
  if (!token) {
    const text = `${result.stdout}\n${result.stderr}`.trim();
    throw new Error(`Could not mint a pairing link: ${text.slice(0, 300)}`);
  }
  return `${origin}/pair#token=${token[1]}`;
}

async function stopRecorded(record) {
  const pgid = Number(record.pgid) || Number(record.pid);
  const leaderRunning = isRunning(record);
  const leaderAlive = Number.isInteger(Number(record.pid)) && proc.isAlive(Number(record.pid));
  const groupBefore = proc.processGroupPids(pgid);
  const rootBefore = proc.fakeProcessPids(record.root);
  if (!leaderRunning && groupBefore.length === 0 && rootBefore.length === 0) {
    return "the PID was not this server any more (left alone)";
  }
  // A live PID the record names, whose own command line does not name this
  // root, is not ours (a recycled PID or a planted record). Nothing is stopped
  // and the root is kept: killing it would hit an unrelated process.
  if (
    !leaderRunning &&
    leaderAlive &&
    !groupBefore.some((member) => proc.namesRoot(member, record.root)) &&
    rootBefore.length === 0
  ) {
    throw new Error(
      `Refusing to stop '${record.name}': PID ${record.pid} does not name ${record.root}.`,
    );
  }
  const ok = await proc.stopProcessTree(Number(record.pid), { pgid, root: record.root });
  if (!ok) {
    throw new Error(
      `The throwaway tree for '${record.name}' is still alive after SIGKILL (group ${pgid}).`,
    );
  }
  // Deleting the root while a fake CLI still reads it would leave that process
  // running from a deleted folder, exactly what tripped the 1.66.99 release.
  const left = proc.fakeProcessPids(record.root);
  if (left.length > 0) {
    throw new Error(`Refusing to delete ${record.root}: PID(s) ${left.join(", ")} still name it.`);
  }
  return leaderRunning
    ? `stopped PID ${record.pid} and its process group ${pgid}`
    : `stopped the orphaned process group ${pgid}`;
}

function removeRoot(root) {
  // NodeFS.rmSync does not follow symlinks it removes, so a linked node_modules
  // inside the root is unlinked, never emptied.
  NodeFS.rmSync(root, { recursive: true, force: true });
}

async function start({ name, release, port, json, schedulersOff, startTimeout = 300 }) {
  const existing = existingRootFor(name);
  if (existing !== null) {
    throw new Error(
      `${existing} already exists. Run stop --name ${name} first: every throwaway starts fresh.`,
    );
  }
  const root = randomRoot(name);
  const bin = resolveBin(release);
  const chosenPort = Number(port) > 0 ? Number(port) : await freePort();
  const origin = `http://127.0.0.1:${chosenPort}`;
  // 0700: `stop` only trusts a root the owner made and nobody else can write
  // into, which is what a planted record has to pass to be believed.
  NodeFS.mkdirSync(root, { mode: 0o700 });
  NodeFS.chmodSync(root, 0o700);
  writeFakeClaude(root);
  writeSettings(root);
  const { pid, pgid, logFile } = startServer({
    name,
    root,
    bin,
    port: chosenPort,
    schedulersOff,
  });
  const record = {
    name,
    root,
    port: chosenPort,
    pid,
    pgid,
    bin,
    node: process.execPath,
    startedAt: new Date().toISOString(),
  };
  writeRecord(root, record);
  if (!(await waitUp(origin, pid, startTimeout * 1000))) {
    const tail = NodeFS.existsSync(logFile)
      ? NodeFS.readFileSync(logFile, "utf8").split(/\r?\n/).slice(-8).join("\n")
      : "";
    await proc.stopProcessTree(pid, { pgid: pgid ?? undefined, root });
    const left = proc.fakeProcessPids(root);
    if (left.length > 0) {
      throw new Error(
        `The server did not come up on ${origin}, and PID(s) ${left.join(", ")} still use ${root}; the root was kept.`,
      );
    }
    removeRoot(root);
    throw new Error(
      `The server did not come up on ${origin}. Root removed. Last log lines:\n${tail}`,
    );
  }
  let pairing = "unavailable";
  try {
    pairing = pairingLink(record);
  } catch (error) {
    pairing = `unavailable: ${error.message}`;
  }
  const version = await fetch(`${origin}/version.txt`)
    .then((response) => response.text())
    .then((text) => text.split(/\r?\n/)[0].trim())
    .catch(() => "");
  const info = {
    name,
    root,
    url: origin,
    pairing,
    pid,
    version,
    stop: `node ${NodePath.join(HERE, "throwaway.mjs")} stop --name ${name}`,
  };
  if (json) console.log(JSON.stringify(info));
  else for (const [key, value] of Object.entries(info)) console.log(`${key}: ${value}`);
  return info;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  const name = args.name;
  switch (command) {
    case "start":
      await start({
        name,
        release: args.release,
        port: args.port,
        json: args.json,
        schedulersOff: args["schedulers-off"] === true,
      });
      return;
    case "stop": {
      const found = foundRootFor(name);
      if (found === null) {
        console.log(`No throwaway root for '${name}' (${ROOT_PREFIX}${name}-*). Nothing to do.`);
        return;
      }
      const rejection = rootRejection(found);
      const record = readRecord(found);
      if (rejection !== null || record === null || !rootRecordMatches(found, record)) {
        throw new Error(
          `Refusing to touch ${found}: ${rejection ?? "its record names another folder"}. Nothing was stopped or deleted.`,
        );
      }
      const stopped = await stopRecorded(record);
      removeRoot(found);
      console.log(`Stopped '${name}': ${stopped}; deleted ${found}.`);
      return;
    }
    case "down": {
      const root = existingRootFor(name);
      const record = root === null ? null : readRecord(root);
      if (!record) throw new Error(`No throwaway root for '${name}'.`);
      if (!isRunning(record)) {
        console.log(`'${name}' is not running. Nothing stopped.`);
        return;
      }
      await stopRecorded(record);
      // The port must be free before a caller treats the laptop as gone.
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline && (await portListening(record.port))) await proc.sleep(200);
      console.log(`Down '${name}': stopped PID ${record.pid}; the root is kept.`);
      return;
    }
    case "up": {
      const root = existingRootFor(name);
      const record = root === null ? null : readRecord(root);
      if (!record) throw new Error(`No throwaway root for '${name}'.`);
      if (isRunning(record)) {
        console.log(`'${name}' is already running (PID ${record.pid}).`);
        return;
      }
      const { pid, pgid } = startServer({
        name,
        root,
        bin: record.bin,
        port: record.port,
        schedulersOff: args["schedulers-off"] === true,
      });
      record.pid = pid;
      record.pgid = pgid;
      record.startedAt = new Date().toISOString();
      writeRecord(root, record);
      const origin = `http://127.0.0.1:${record.port}`;
      if (!(await waitUp(origin, pid, 300_000)))
        throw new Error(`'${name}' did not come back on ${origin}.`);
      console.log(`Up '${name}': PID ${pid} on ${origin}.`);
      return;
    }
    case "pair": {
      const root = existingRootFor(name);
      const record = root === null ? null : readRecord(root);
      if (!record || !isRunning(record)) {
        throw new Error(
          `'${name}' is not running. Start it with start --name ${name} --release <release>.`,
        );
      }
      console.log(pairingLink(record));
      return;
    }
    case "list": {
      const rows = NodeFS.readdirSync(NodeOS.tmpdir())
        .filter((entry) => entry.startsWith(ROOT_PREFIX))
        .map((entry) => {
          const root = NodePath.join(NodeOS.tmpdir(), entry);
          const record = readRecord(root);
          return {
            name: record?.name ?? entry.slice(ROOT_PREFIX.length),
            root,
            port: record?.port ?? null,
            pid: record?.pid ?? null,
            running: isRunning(record),
          };
        });
      if (args.json) console.log(JSON.stringify(rows));
      else
        for (const row of rows)
          console.log(
            `${row.name}\t${row.running ? "running" : "stopped"}\t${row.port ?? "-"}\t${row.root}`,
          );
      return;
    }
    default:
      console.error(
        "usage: throwaway.mjs start|stop|pair|down|up|list [--name N] [--release R] [--port P] [--json]",
      );
      process.exit(2);
  }
}

function portListening(port) {
  return new Promise((resolve) => {
    const socket = NodeNet.connect({ port, host: "127.0.0.1" });
    socket.setTimeout(500);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

const isMain =
  process.argv[1] !== undefined &&
  NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(error.message ?? String(error));
    process.exit(1);
  });
}
