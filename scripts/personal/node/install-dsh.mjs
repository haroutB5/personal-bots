#!/usr/bin/env node
// Installs the pinned DeepSeek Harness (dsh) runtime once per machine, outside
// every release folder.
//
//   install-dsh.mjs [--version <pin>] [--force] [--home <hbots home>]
//                   [--node <node>] [--npm <npm>]
//
// Copies scripts/personal/dsh-runtime/{package.json,package-lock.json,hbots-deny-plugin.mjs}
// into <home>/runtimes/dsh-<pin>/ and installs it with
// `npm ci --ignore-scripts --no-audit --no-fund` from the committed lockfile.
// It then runs `node <dir>/node_modules/@deepseek-ai/dsh/lib/bin.js --version`
// and refuses unless that prints the pin.
//
// The tree is about 509 MB with native addons, and hbots releases are retained
// and never pruned, so this never goes inside a release folder. Idempotent: a
// version that already answers its own `--version` is skipped.
//
// Exit codes: 0 installed or already present, 1 a failure (message on stderr).
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { pbHome } from "./lib/paths.mjs";

const DEFAULT_VERSION = "0.2.1-rc.3";
const SOURCE_FILES = ["package.json", "package-lock.json", "hbots-deny-plugin.mjs"];
const NPM_ARGS = ["ci", "--ignore-scripts", "--no-audit", "--no-fund"];

function usage() {
  return "Usage: install-dsh.mjs [--version <pin>] [--force] [--home <dir>] [--node <node>] [--npm <npm>]";
}

function parseArgs(argv) {
  const options = { force: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--force") {
      options.force = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (!arg.startsWith("--")) throw new Error(`Unexpected argument '${arg}'. ${usage()}`);
    const key = arg.slice(2);
    const value = argv[(index += 1)];
    if (value === undefined) throw new Error(`${arg} needs a value. ${usage()}`);
    if (!["version", "home", "node", "npm"].includes(key)) {
      throw new Error(`Unknown option '${arg}'. ${usage()}`);
    }
    options[key] = value;
  }
  return options;
}

function dshBinJs(runtimeDir) {
  return NodePath.join(runtimeDir, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
}

function dshVersion(nodeExe, binJs) {
  if (!NodeFS.existsSync(binJs)) return null;
  try {
    const output = NodeChildProcess.spawnSync(nodeExe, [binJs, "--version"], {
      encoding: "utf8",
    });
    if (output.status !== 0) return null;
    return (output.stdout.split(/\r?\n/)[0] ?? "").trim() || null;
  } catch {
    return null;
  }
}

function install({ pin, runtimeDir, sourceDir, nodeExe, npmCommand, force }) {
  console.log(`runtime: ${runtimeDir}`);
  const binJs = dshBinJs(runtimeDir);

  if (!force) {
    const installed = dshVersion(nodeExe, binJs);
    if (installed === pin) {
      console.log(`dsh ${pin} already installed at ${runtimeDir}`);
      return;
    }
    if (installed !== null) {
      console.log(
        `dsh at ${runtimeDir} answers '${installed}', not the pin '${pin}'. Reinstalling.`,
      );
    }
  }

  if (!NodeFS.existsSync(sourceDir) || !NodeFS.statSync(sourceDir).isDirectory()) {
    throw new Error(
      `Missing ${sourceDir} (the committed package.json, package-lock.json and deny plugin).`,
    );
  }
  for (const file of SOURCE_FILES) {
    if (!NodeFS.existsSync(NodePath.join(sourceDir, file))) {
      throw new Error(`Missing ${NodePath.join(sourceDir, file)}.`);
    }
  }

  NodeFS.mkdirSync(runtimeDir, { recursive: true });
  for (const file of SOURCE_FILES) {
    NodeFS.copyFileSync(NodePath.join(sourceDir, file), NodePath.join(runtimeDir, file));
  }

  console.log(`Installing dsh ${pin} into ${runtimeDir} (npm ci --ignore-scripts)...`);
  // npm ci is the only install path: it deletes node_modules and installs
  // exactly the committed lockfile.
  const result = NodeChildProcess.spawnSync(npmCommand, NPM_ARGS, {
    cwd: runtimeDir,
    stdio: "inherit",
    shell: process.platform === "win32",
    env: process.env,
  });
  if (result.error !== undefined) {
    throw new Error(`Could not run ${npmCommand} in ${runtimeDir}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`npm ci failed in ${runtimeDir} (exit ${result.status}).`);
  }

  const installed = dshVersion(nodeExe, binJs);
  if (installed !== pin) {
    throw new Error(
      `Installed dsh answers '${installed ?? "nothing"}', expected '${pin}'. Nothing was activated: check the lockfile, then run this again.`,
    );
  }
  console.log(`dsh ${pin} ready at ${runtimeDir} (bin: ${binJs})`);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help === true) {
    console.log(usage());
    return;
  }
  const pin = options.version ?? DEFAULT_VERSION;
  const home = options.home === undefined ? pbHome() : NodePath.resolve(options.home);
  // The resolved directory is named on every run: the card, the adapter and a
  // later failure report must all say which runtime this machine installed.
  install({
    pin,
    runtimeDir: NodePath.join(home, "runtimes", `dsh-${pin}`),
    sourceDir: NodePath.join(import.meta.dirname, "..", "dsh-runtime"),
    nodeExe: options.node ?? process.execPath,
    npmCommand: options.npm ?? "npm",
    force: options.force === true,
  });
}

try {
  main();
} catch (error) {
  console.error(`install-dsh: ${error.message}`);
  process.exitCode = 1;
}
