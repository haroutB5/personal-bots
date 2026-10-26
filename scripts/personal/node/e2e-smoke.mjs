#!/usr/bin/env node
// Phone e2e smoke suite for a staged hbots release on Linux: the same five
// journeys as scripts/personal/e2e-smoke.ps1, in a real Brave against a
// throwaway server (the Linux twin of the PowerShell wrapper).
//
//   e2e-smoke.mjs --release <folder|worktree|sha12> [--journey a,b]
//                 [--name <n>] [--artifacts-dir <dir>] [--suite-timeout <s>]
//                 [--browser <brave>] [--json]
//
// Exit code: 0 all journeys passed; 1 a journey failed; 2 setup failed;
// 3 something was left behind or the suite timed out. `--json` prints one line
// with `journeys: [{id, ok, ms}]` and `failed`, the shape gate-evidence.mjs
// reads.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const THROWAWAY = path.join(HERE, "throwaway.mjs");
const RUNNER = path.join(HERE, "..", "e2e", "run.mjs");
const SMOKE_FIVE = new Set([
  "bots-list-chat",
  "new-chat-named",
  "delegate-task",
  "chats-search",
  "long-press-reply",
]);

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    if (key === "json") out[key] = true;
    else out[key] = argv[(i += 1)];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

/**
 * Without --release, the staged release built from the checkout's HEAD is used:
 * the gate runs from the repo root, and the release folder's VERSION names the
 * commit it was built from. Picking by hand here would let a gate run against
 * the wrong artifact.
 */
function stagedReleaseForHead() {
  const head = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).stdout?.trim();
  if (!head) throw new Error("Not in a git checkout; pass --release.");
  const releases = path.join(os.homedir(), ".personal-bots", "releases");
  const candidates = fs.existsSync(releases)
    ? fs.readdirSync(releases, { withFileTypes: true }).filter((entry) => entry.isDirectory())
    : [];
  for (const entry of candidates) {
    const dir = path.join(releases, entry.name);
    const version = path.join(dir, "VERSION");
    if (!fs.existsSync(version)) continue;
    const text = fs.readFileSync(version, "utf8");
    if (!/^dirty=false$/m.test(text)) continue;
    if (!new RegExp(`^sha=${head.slice(0, 12)}`, "m").test(text)) continue;
    return dir;
  }
  throw new Error(
    `No staged release for HEAD ${head.slice(0, 12)}; run build first or pass --release.`,
  );
}

if (!args.release) {
  try {
    args.release = stagedReleaseForHead();
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }
}
const name =
  args.name ??
  `e2e-${new Date()
    .toISOString()
    .replace(/[-:TZ.]/g, "")
    .slice(0, 14)}-${process.pid}`;
const artifacts = args["artifacts-dir"] ?? path.join(os.tmpdir(), "hbots-e2e", name);
const wanted = args.journey
  ? args.journey
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean)
  : null;
const onlySmoke = wanted !== null && wanted.every((id) => SMOKE_FIVE.has(id));
const suiteTimeout =
  Number(args["suite-timeout"]) > 0 ? Number(args["suite-timeout"]) : onlySmoke ? 180 : 600;
if (args.browser) process.env.E2E_BROWSER_EXECUTABLE = args.browser;

const startedAt = Date.now();
let server = null;
let serverStarted = false;
let result = null;
let exit = 2;
const leftovers = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function runNode(script, scriptArgs, { timeout = 300_000 } = {}) {
  return spawnSync(process.execPath, [script, ...scriptArgs], {
    encoding: "utf8",
    timeout,
    env: process.env,
  });
}

const portListening = (port) =>
  new Promise((resolve) => {
    const net = spawnSync("ss", ["-ltnH"], { encoding: "utf8" }).stdout ?? "";
    resolve(net.split(/\r?\n/).some((line) => new RegExp(`[:.]${port}\\s`).test(line)));
  });

async function main() {
  try {
    const start = runNode(THROWAWAY, [
      "start",
      "--name",
      name,
      "--release",
      args.release,
      "--json",
    ]);
    serverStarted = true; // even a half-started root is removed below
    const jsonLine = `${start.stdout}`
      .split(/\r?\n/)
      .filter((line) => /^\s*\{.*\}\s*$/.test(line))
      .pop();
    if (start.status !== 0 || !jsonLine) {
      const tail = `${start.stdout}\n${start.stderr}`.trim().split(/\r?\n/).slice(-5).join(" | ");
      throw new Error(`throwaway.mjs start failed (exit ${start.status}): ${tail}`);
    }
    server = JSON.parse(jsonLine);
    console.log(`e2e server ${name} at ${server.url} (release ${args.release})`);

    const record = JSON.parse(fs.readFileSync(path.join(server.root, "throwaway.json"), "utf8"));
    fs.mkdirSync(artifacts, { recursive: true });
    const stdout = path.join(artifacts, "runner.out.txt");
    const stderr = path.join(artifacts, "runner.err.txt");
    const runnerArgs = [
      RUNNER,
      "--url",
      server.url,
      "--pair",
      server.pairing,
      "--bin",
      String(record.bin),
      "--out",
      artifacts,
      "--name",
      name,
      "--tw-node",
      THROWAWAY,
      "--root",
      String(server.root),
    ];
    if (wanted) runnerArgs.push("--journeys", wanted.join(","));
    const outFd = fs.openSync(stdout, "w");
    const errFd = fs.openSync(stderr, "w");
    const child = spawn(process.execPath, runnerArgs, {
      stdio: ["ignore", outFd, errFd],
      env: process.env,
    });
    fs.closeSync(outFd);
    fs.closeSync(errFd);
    const runnerPid = child.pid;

    const finished = await Promise.race([
      new Promise((resolve) => child.once("exit", (code) => resolve({ code }))),
      sleep(suiteTimeout * 1000).then(() => ({ timeout: true })),
    ]);
    if (finished.timeout) {
      console.warn(`e2e suite is past ${suiteTimeout} s; stopping the runner and its browser.`);
      const browserPidFile = path.join(artifacts, "browser.pid");
      if (fs.existsSync(browserPidFile)) {
        const browserPid = Number(fs.readFileSync(browserPidFile, "utf8").trim());
        if (Number.isInteger(browserPid) && browserPid > 0) {
          try {
            process.kill(-browserPid, "SIGKILL");
          } catch {
            try {
              process.kill(browserPid, "SIGKILL");
            } catch {
              // Already gone.
            }
          }
        }
      }
      try {
        process.kill(-runnerPid, "SIGKILL");
      } catch {
        try {
          process.kill(runnerPid, "SIGKILL");
        } catch {
          // Already gone.
        }
      }
      leftovers.push(`suite exceeded ${suiteTimeout} s`);
      exit = 3;
    } else {
      exit = finished.code ?? 2;
    }
    if (fs.existsSync(stdout)) console.log(fs.readFileSync(stdout, "utf8").trimEnd());
    if (fs.existsSync(stderr) && fs.statSync(stderr).size > 0) {
      console.log(fs.readFileSync(stderr, "utf8").trimEnd());
    }
    const resultFile = path.join(artifacts, "result.json");
    if (fs.existsSync(resultFile)) result = JSON.parse(fs.readFileSync(resultFile, "utf8"));
    if (exit !== 3) {
      if (!result) exit = 2;
      else if (result.ok) exit = 0;
      else if (result.setupError) exit = 2;
      else exit = 1;
    }
  } catch (error) {
    console.log(`e2e setup failed: ${error?.message ?? error}`);
    exit = 2;
  } finally {
    if (serverStarted) {
      const stop = runNode(THROWAWAY, ["stop", "--name", name]);
      const line = `${stop.stdout}`.trim().split(/\r?\n/).filter(Boolean).slice(-2).join(" | ");
      if (line) console.log(line);
    }
    const root = path.join(os.tmpdir(), `hbots-tw-${name}`);
    if (fs.existsSync(root)) leftovers.push(`root ${root} still exists`);
    if (server) {
      if (await portListening(Number(new URL(server.url).port))) {
        leftovers.push(`port ${new URL(server.url).port} still listening`);
      }
    }
  }

  if (leftovers.length > 0) {
    console.log(`e2e LEFTOVERS: ${leftovers.join("; ")}`);
    if (exit === 0 || exit === 1) exit = 3;
  }
  if (exit === 0 && fs.existsSync(artifacts)) {
    fs.rmSync(artifacts, { recursive: true, force: true });
    const parent = path.dirname(artifacts);
    if (path.basename(parent) === "hbots-e2e" && fs.readdirSync(parent).length === 0) {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  } else if (fs.existsSync(artifacts)) {
    console.log(`e2e artifacts kept for the failure: ${artifacts}`);
  }
  const seconds = Math.round(((Date.now() - startedAt) / 1000) * 10) / 10;
  console.log(`e2e smoke exit ${exit} in ${seconds} s`);
  if (args.json) {
    const failures = [];
    if (result) {
      for (const journey of result.results ?? []) {
        if (!journey.ok)
          failures.push(`${journey.id}: ${String(journey.error ?? "").split("\n")[0]}`);
      }
      if (result.setupError) failures.push(`setup: ${String(result.setupError).split("\n")[0]}`);
    }
    console.log(
      JSON.stringify({
        exit,
        seconds,
        release: args.release,
        passed: result?.passed ?? 0,
        failed: result?.failed ?? null,
        failures,
        journeys: (result?.results ?? []).map((journey) => ({
          id: journey.id,
          ok: Boolean(journey.ok),
          ms: journey.ms,
        })),
        leftovers,
        artifacts: exit === 0 ? null : artifacts,
      }),
    );
  }
  process.exit(exit);
}

await main();
