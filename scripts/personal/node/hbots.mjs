#!/usr/bin/env node
// hbots ops CLI for Linux (and cross-platform where the same operation is
// safe). The Windows release flow stays PowerShell until the switch-over:
// mutating commands refuse the live Windows home.
//
// Usage: node scripts/personal/node/hbots.mjs <command> [options]
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { defaultPort, getPaths, pbHome, repoRootFromScript } from "./lib/paths.mjs";
import { ensureDirs, loadRepoEnv, log, readJson, warn } from "./lib/util.mjs";
import * as proc from "./lib/proc.mjs";
import { activeReleaseName, pruneReleases, resolveRelease, selectPrunable, setActiveRelease } from "./lib/release.mjs";
import { backupRoot } from "./lib/backup.mjs";
import { describeStatus, formatVersionFile, restartServer, serveForeground, startServer, stopServer, systemdUnitActive } from "./lib/server.mjs";
import { runSmoke } from "./lib/smoke.mjs";
import { stageRelease } from "./lib/build.mjs";
import { upstreamSync } from "./lib/upstream.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = repoRootFromScript(import.meta.url);
const SNAPSHOT_SCRIPT = path.join(repoRoot, "scripts", "personal", "sqlite-snapshot.cjs");

const COMMANDS = `
hbots ops CLI

  build      stage a release (default: no activation)
  activate   point current.txt at a release
  start      start the server detached against a data root
  serve      run the server in the foreground (systemd ExecStart)
  stop       stop the recorded server
  restart    stop and start, or restart the systemd unit
  status     show state, release and runtime
  smoke      live checks (process, local, tunnel, stability, logs)
  backup     snapshot a data root
  prune      remove old releases
  sync       upstream merge or dependency update, gated and rolled back
  units      install user systemd units (Linux)
  version    print this tool's repository and Node version

Common options: --root dev|prod  --home <dir>  --json  --help
`;

function parse(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      root: { type: "string", default: "dev" },
      home: { type: "string" },
      "releases-dir": { type: "string" },
      release: { type: "string" },
      port: { type: "string" },
      keep: { type: "string" },
      protect: { type: "string", multiple: true },
      "copy-externals": { type: "boolean", default: false },
      activate: { type: "boolean", default: false },
      "skip-build": { type: "boolean", default: false },
      "skip-gate": { type: "boolean", default: false },
      "skip-smoke": { type: "boolean", default: false },
      "allow-dirty": { type: "boolean", default: false },
      detach: { type: "boolean", default: true },
      "no-systemd": { type: "boolean", default: false },
      "no-tunnel": { type: "boolean", default: false },
      "stable-seconds": { type: "string", default: "120" },
      "start-timeout": { type: "string", default: "90" },
      "log-file": { type: "string" },
      "log-from-byte": { type: "string", default: "-1" },
      "expect-release": { type: "string" },
      dryrun: { type: "boolean", default: true },
      apply: { type: "boolean", default: false },
      mode: { type: "string", default: "upstream" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  return { command: positionals[0] ?? null, values };
}

function pathsFor(values) {
  const home = values.home ? path.resolve(values.home) : pbHome();
  return getPaths({ root: values.root, home, releasesDir: values["releases-dir"] ?? null });
}

function assertMutationAllowed(paths) {
  // Never touch the live installation through this tool while the machine is
  // still Windows: the release flow there is PowerShell.
  if (process.platform === "win32" && path.resolve(paths.home) === path.resolve(pbHome())) {
    throw new Error(
      "Refusing to change the live Windows install from the Node tooling (the Windows flow is PowerShell). " +
        "Set HBOTS_HOME (or --home) to a throwaway root for tests.",
    );
  }
}

function printStatus(status, asJson) {
  if (asJson) {
    process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
    return;
  }
  const state = status.state;
  log(`root        ${status.root}`);
  log(`home        ${status.home}`);
  log(`active      ${status.active ?? "(none)"}`);
  log(`running     ${status.alive ? `yes, pid ${state.pid}, release ${state.release}` : "no"}`);
  if (state) log(`state       ${pathsFor({ root: status.root, home: status.home }).stateFile}`);
  if (status.runtime) log(`origin      ${status.runtime.origin ?? "?"} (started ${status.runtime.startedAt ?? "?"})`);
  if (status.version) {
    log(`version     ${status.version.version ?? "?"}  release ${status.version.release ?? "?"}  sha ${status.version.sha ?? "?"}`);
    log(`built       ${status.version.builtAt ?? "?"}  externals ${status.version.externals ?? "?"}`);
  }
}

async function main() {
  const { command, values } = parse(process.argv.slice(2));
  if (!command || values.help) {
    process.stdout.write(COMMANDS);
    return 0;
  }
  const paths = pathsFor(values);
  const nodeExe = process.execPath;

  switch (command) {
    case "build": {
      assertMutationAllowed(paths);
      ensureDirs([paths.releasesDir, paths.runDir, paths.logsDir, paths.workDir]);
      const running = proc.readState(paths);
      if (!values["allow-dirty"] && running && proc.isServerProcess(Number(running.pid), running)) {
        const dirty = proc.commandLine(Number(running.pid)) || "";
        if (!dirty) warn("Could not read the running process command line; continuing.");
      }
      const staged = stageRelease({
        repoRoot,
        paths,
        copyExternals: values["copy-externals"],
        skipBuild: values["skip-build"],
        nodeExe,
      });
      if (values.activate) {
        setActiveRelease(paths, staged.name);
        log(`Active release set to ${staged.name}.`);
      }
      log("");
      log(`Release staged: ${staged.dir}`);
      log(`  ${staged.version}, ${staged.branch}@${staged.sha}, built ${staged.builtAt}, externals=${staged.externalsMode}`);
      log(values.activate ? "  Active release updated (--activate)." : `  Staged, not activated. Activate with: activate --release ${staged.name}`);
      return 0;
    }
    case "activate": {
      assertMutationAllowed(paths);
      if (!values.release) throw new Error("activate needs --release <name>.");
      const release = setActiveRelease(paths, values.release);
      log(`Active release set to ${release.name}.`);
      return 0;
    }
    case "start": {
      assertMutationAllowed(paths);
      const port = values.port ? Number(values.port) : defaultPort(paths.root);
      const result = await startServer({ paths, repoRoot, releaseName: values.release, nodeExe, port, waitMs: 60000 });
      if (result.alreadyRunning) {
        log(`Personal Bots is already running (pid ${result.state.pid}, release ${result.state.release}).`);
      } else {
        log(`Personal Bots started: pid ${result.state.pid}, release ${result.state.release}, root ${paths.root}, ready=${result.ready}`);
        log(`Log: ${result.logFile}`);
      }
      return 0;
    }
    case "serve": {
      const port = values.port ? Number(values.port) : defaultPort(paths.root);
      return await serveForeground({ paths, repoRoot, releaseName: values.release, nodeExe, port });
    }
    case "stop": {
      assertMutationAllowed(paths);
      const result = await stopServer({ paths });
      if (result.stopped) log(`Stopped Personal Bots (pid ${result.pid}, release ${result.release}).`);
      else log(`Personal Bots is not running (${result.reason}).`);
      return 0;
    }
    case "restart": {
      assertMutationAllowed(paths);
      const result = await restartServer({
        paths,
        repoRoot,
        releaseName: values.release,
        keepReleases: values.keep ? Number(values.keep) : 5,
        viaSystemd: values["no-systemd"] ? false : null,
        nodeExe,
      });
      log(`Personal Bots restarted: pid ${result.state.pid}, release ${result.state.release}.`);
      return 0;
    }
    case "status": {
      const status = describeStatus({ paths });
      printStatus(status, values.json);
      return status.alive ? 0 : 1;
    }
    case "smoke": {
      const result = await runSmoke({
        paths,
        expectRelease: values["expect-release"] ?? values.release ?? null,
        startTimeoutSeconds: Number(values["start-timeout"]),
        stableSeconds: Number(values["stable-seconds"]),
        noTunnel: values["no-tunnel"],
        logFile: values["log-file"] ?? null,
        logFromByte: Number(values["log-from-byte"]),
        nodeExe,
      });
      for (const line of result.lines) log(line);
      log(result.ok ? "Smoke PASSED." : `Smoke FAILED (${result.failures.length} problem(s)).`);
      return result.ok ? 0 : 1;
    }
    case "backup": {
      assertMutationAllowed(paths);
      const result = backupRoot({ paths, keep: values.keep ? Number(values.keep) : 1, nodeExe, snapshotScript: SNAPSHOT_SCRIPT });
      log(`Backup written: ${result.target} (${result.timings.sizeMb} MB; ${result.items.join(", ")})`);
      if (result.pruned.length) log(`Pruned: ${result.pruned.join(", ")}`);
      return 0;
    }
    case "prune": {
      assertMutationAllowed(paths);
      const state = proc.readState(paths);
      const prunable = pruneReleases({
        paths,
        keep: values.keep ? Number(values.keep) : 5,
        protect: values.protect ?? [],
        running: state ? state.release : null,
        dryRun: !values.apply,
      });
      if (!prunable.length) log("No releases to prune.");
      else if (!values.apply) log(`Dry run: ${prunable.length} release(s) would be removed. Add --apply to remove them.`);
      return 0;
    }
    case "sync": {
      assertMutationAllowed(paths);
      const dryRun = !values.apply;
      if (!["upstream", "updates"].includes(values.mode)) throw new Error("--mode must be upstream or updates.");
      const result = await upstreamSync({
        repoRoot,
        paths,
        mode: values.mode,
        dryRun,
        nodeExe,
        skipGate: values["skip-gate"],
        skipSmoke: values["skip-smoke"],
        keepReleases: values.keep ? Number(values.keep) : 5,
      });
      if (result.dryRun) log("Dry run only. Add --apply to run it.");
      return 0;
    }
    case "units": {
      const script = path.join(repoRoot, "scripts", "personal", "linux", "install-units.sh");
      if (!fs.existsSync(script)) throw new Error(`Missing ${script}`);
      const { spawnSync } = await import("node:child_process");
      const result = spawnSync("bash", [script, ...(values.apply ? [] : ["--dry-run"])], { stdio: "inherit" });
      return result.status ?? 1;
    }
    case "version": {
      log(`hbots ops CLI (${process.platform}/${process.arch}), node ${process.version}`);
      log(`repo ${repoRoot}`);
      log(`home ${paths.home}`);
      return 0;
    }
    default:
      warn(`Unknown command: ${command}`);
      process.stdout.write(COMMANDS);
      return 2;
  }
}

main()
  .then((code) => process.exit(code ?? 0))
  .catch((error) => {
    warn(`error: ${error.message}`);
    process.exit(1);
  });
