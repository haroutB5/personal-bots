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
// server listens on 127.0.0.1 only. PIDs are only touched after
// /proc/<pid>/cmdline still names the recorded binary and root.
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import * as proc from "./lib/proc.mjs";
import { getPaths } from "./lib/paths.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT_PREFIX = "hbots-tw-";
const RECORD = "throwaway.json";
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,30}$/;
const FAKE_SOURCE = path.join(HERE, "..", "testing", "fake-claude");

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

function rootFor(name) {
  if (!NAME_PATTERN.test(name ?? "")) {
    throw new Error(
      `Name '${name}' must be 1 to 31 characters: lower-case letters, digits and dashes, starting with a letter or digit.`,
    );
  }
  return path.join(os.tmpdir(), ROOT_PREFIX + name);
}

const readRecord = (root) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, RECORD), "utf8"));
  } catch {
    return null;
  }
};
const writeRecord = (root, value) =>
  fs.writeFileSync(path.join(root, RECORD), `${JSON.stringify(value, null, 2)}\n`);

function resolveBin(where) {
  const bases = [where];
  if (/^[0-9a-f]{7,40}$/.test(where)) bases.push(path.join(getPaths({}).releasesDir, where));
  for (const base of bases) {
    for (const relative of ["dist/bin.mjs", "apps/server/dist/bin.mjs"]) {
      const candidate = path.resolve(base, relative);
      if (fs.existsSync(candidate)) return candidate;
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
    const server = net.createServer();
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
    const dir = path.join(root, "fake", persona);
    const pkg = path.join(dir, "node_modules", "@anthropic-ai", "claude-code");
    fs.mkdirSync(pkg, { recursive: true });
    fs.copyFileSync(path.join(FAKE_SOURCE, "cli.js"), path.join(pkg, "cli.js"));
    fs.copyFileSync(path.join(FAKE_SOURCE, "package.json"), path.join(pkg, "package.json"));
    const launcher = path.join(dir, "claude");
    fs.writeFileSync(
      launcher,
      `#!/bin/sh\nexec ${JSON.stringify(nodeExe)} ${JSON.stringify(path.join(pkg, "cli.js"))} "$@"\n`,
    );
    fs.chmodSync(launcher, 0o755);
  }
}

function writeSettings(root) {
  const fake = (persona) => path.join(root, "fake", persona, "claude");
  const home = (name) => path.join(root, "homes", name);
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
  fs.mkdirSync(path.join(root, "userdata"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "userdata", "settings.json"),
    `${JSON.stringify(settings, null, 2)}\n`,
  );
}

function serverEnv(name, root, schedulersOff) {
  const env = {
    ...process.env,
    PERSONAL_SEED_MODEL: "claude-sonnet-5-5",
    FAKE_CLAUDE_PID_DIR: path.join(root, "fake-pids"),
    T3CODE_PERSONAL_BROWSER_HEADLESS: "1",
    T3CODE_AUTO_CONNECT: "false",
    T3CODE_ENVIRONMENT_LABEL: `throwaway ${name}`,
    GROK_HOME: path.join(root, "homes", "grok"),
    OPENCODE_DATA_DIR: path.join(root, "homes", "opencode"),
    ANTIGRAVITY_DATA_DIR: path.join(root, "homes", "antigravity"),
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
  fs.mkdirSync(path.join(root, "fake-pids"), { recursive: true });
  for (const home of ["claude", "codex", "deepseek", "grok", "opencode", "antigravity"]) {
    fs.mkdirSync(path.join(root, "homes", home), { recursive: true });
  }
  const logFile = path.join(root, "server.log");
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
  return { pid: child.pid, logFile };
}

function pairingLink(record) {
  const origin = `http://127.0.0.1:${record.port}`;
  const result = spawnSync(process.execPath, [record.bin, "pair", "--base-dir", record.root], {
    encoding: "utf8",
    timeout: 60_000,
  });
  const token = /^\s*Token:\s*(\S+)/m.exec(`${result.stdout}\n${result.stderr}`);
  if (!token) {
    const text = `${result.stdout}\n${result.stderr}`.trim();
    throw new Error(`Could not mint a pairing link: ${text.slice(0, 300)}`);
  }
  return `${origin}/pair#token=${token[1]}`;
}

async function stopRecorded(record) {
  if (!isRunning(record)) return "the PID was not this server any more (left alone)";
  const ok = await proc.stopProcessTree(Number(record.pid));
  if (!ok) throw new Error(`PID ${record.pid} is still alive after SIGKILL.`);
  return `stopped PID ${record.pid}`;
}

function removeRoot(root) {
  // fs.rmSync does not follow symlinks it removes, so a linked node_modules
  // inside the root is unlinked, never emptied.
  fs.rmSync(root, { recursive: true, force: true });
}

async function start({ name, release, port, json, schedulersOff, startTimeout = 300 }) {
  const root = rootFor(name);
  if (fs.existsSync(root)) {
    throw new Error(
      `${root} already exists. Run stop --name ${name} first: every throwaway starts fresh.`,
    );
  }
  const bin = resolveBin(release);
  const chosenPort = Number(port) > 0 ? Number(port) : await freePort();
  const origin = `http://127.0.0.1:${chosenPort}`;
  fs.mkdirSync(root, { recursive: true });
  writeFakeClaude(root);
  writeSettings(root);
  const { pid, logFile } = startServer({ name, root, bin, port: chosenPort, schedulersOff });
  const record = {
    name,
    root,
    port: chosenPort,
    pid,
    bin,
    node: process.execPath,
    startedAt: new Date().toISOString(),
  };
  writeRecord(root, record);
  if (!(await waitUp(origin, pid, startTimeout * 1000))) {
    const tail = fs.existsSync(logFile)
      ? fs.readFileSync(logFile, "utf8").split(/\r?\n/).slice(-8).join("\n")
      : "";
    if (proc.isAlive(pid)) await proc.stopProcessTree(pid);
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
    stop: `node ${path.join(HERE, "throwaway.mjs")} stop --name ${name}`,
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
      const root = rootFor(name);
      if (!fs.existsSync(root)) {
        console.log(`No throwaway root for '${name}' (${root}). Nothing to do.`);
        return;
      }
      const record = readRecord(root);
      const stopped = record ? await stopRecorded(record) : "no recorded server";
      removeRoot(root);
      console.log(`Stopped '${name}': ${stopped}; deleted ${root}.`);
      return;
    }
    case "down": {
      const record = readRecord(rootFor(name));
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
      const root = rootFor(name);
      const record = readRecord(root);
      if (!record) throw new Error(`No throwaway root for '${name}'.`);
      if (isRunning(record)) {
        console.log(`'${name}' is already running (PID ${record.pid}).`);
        return;
      }
      const { pid } = startServer({
        name,
        root,
        bin: record.bin,
        port: record.port,
        schedulersOff: args["schedulers-off"] === true,
      });
      record.pid = pid;
      record.startedAt = new Date().toISOString();
      writeRecord(root, record);
      const origin = `http://127.0.0.1:${record.port}`;
      if (!(await waitUp(origin, pid, 300_000)))
        throw new Error(`'${name}' did not come back on ${origin}.`);
      console.log(`Up '${name}': PID ${pid} on ${origin}.`);
      return;
    }
    case "pair": {
      const record = readRecord(rootFor(name));
      if (!record || !isRunning(record)) {
        throw new Error(
          `'${name}' is not running. Start it with start --name ${name} --release <release>.`,
        );
      }
      console.log(pairingLink(record));
      return;
    }
    case "list": {
      const rows = fs
        .readdirSync(os.tmpdir())
        .filter((entry) => entry.startsWith(ROOT_PREFIX))
        .map((entry) => {
          const root = path.join(os.tmpdir(), entry);
          const record = readRecord(root);
          return {
            name: entry.slice(ROOT_PREFIX.length),
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
    const socket = net.connect({ port, host: "127.0.0.1" });
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

main().catch((error) => {
  console.error(error.message ?? String(error));
  process.exit(1);
});
