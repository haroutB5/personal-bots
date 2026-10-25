// Upstream sync and dependency updates for the Linux host. These are the only
// commands that move the checkout itself, so every step is logged, the tree
// must be clean, and a failed release is rolled back to the previous binary.
// The database is never restored automatically.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { runSmoke } from "./smoke.mjs";
import { stageRelease } from "./build.mjs";
import { activeReleaseName } from "./release.mjs";
import { restartServer, startServer, stopServer } from "./server.mjs";

function git(repoRoot, args, { allowFail = false } = {}) {
  const result = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" });
  if (result.status !== 0 && !allowFail) throw new Error(`git ${args.join(" ")} failed: ${(result.stderr || "").trim()}`);
  return { code: result.status ?? 1, stdout: (result.stdout || "").trim(), stderr: (result.stderr || "").trim() };
}

function vp(repoRoot, args, nodeExe, label, { cwd = repoRoot } = {}) {
  const bin = path.join(repoRoot, "node_modules", ".bin", "vp");
  if (!fs.existsSync(bin)) throw new Error("vite-plus (vp) is not installed in this checkout.");
  const head = (() => {
    try {
      return fs.readFileSync(bin, "utf8").slice(0, 200);
    } catch {
      return "";
    }
  })();
  const useNode = head.startsWith("#!") && head.includes("node");
  const command = useNode ? nodeExe : bin;
  process.stdout.write(`\n== ${label}: vp ${args.join(" ")} (${cwd})\n`);
  const result = spawnSync(command, useNode ? [bin, ...args] : args, { cwd, stdio: "inherit", windowsHide: true });
  if (result.status !== 0) throw new Error(`${label} failed (exit ${result.status}).`);
}

export function runGate({ repoRoot, nodeExe = process.execPath }) {
  vp(repoRoot, ["test", "run", "src/personal"], nodeExe, "server personal tests", { cwd: path.join(repoRoot, "apps", "server") });
  vp(repoRoot, ["exec", "tsc", "--noEmit"], nodeExe, "server typecheck", { cwd: path.join(repoRoot, "apps", "server") });
  vp(repoRoot, ["test", "run", "--project", "unit", "src/features/personal"], nodeExe, "web personal tests", { cwd: path.join(repoRoot, "apps", "web") });
}

export async function upstreamSync({
  repoRoot,
  paths,
  mode = "upstream",
  dryRun = true,
  nodeExe = process.execPath,
  skipGate = false,
  skipSmoke = false,
  keepReleases = 5,
}) {
  const steps = [];
  const log = (line) => {
    steps.push(line);
    process.stdout.write(`${line}\n`);
  };

  const branch = git(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]).stdout;
  const dirty = git(repoRoot, ["status", "--porcelain", "--untracked-files=no"]).stdout;
  if (dirty) throw new Error("Refusing to sync: the checkout has uncommitted changes. Commit or discard them first (never by force).");
  const remote = git(repoRoot, ["remote"], { allowFail: true }).stdout.split(/\r?\n/);
  if (mode === "upstream" && !remote.includes("upstream")) throw new Error("No 'upstream' remote in this checkout.");

  log(`mode=${mode} branch=${branch} dryRun=${dryRun}`);
  const rollback = activeReleaseName(paths);
  log(`rollback target: ${rollback ?? "none"}`);

  if (dryRun) {
    if (mode === "upstream") {
      log("would: git fetch upstream --prune");
      log("would: git merge upstream/main --no-edit (skip when already up to date)");
    } else {
      log("would: vp i (dependency update; lockfile backed up first)");
    }
    log("would: gate (server personal tests, server tsc, web personal tests)");
    log("would: stage a release with copy-externals");
    log("would: restart, smoke (no tunnel), roll back the binary on failure");
    return { ok: true, dryRun: true, steps };
  }

  if (mode === "upstream") {
    log("git fetch upstream --prune");
    git(repoRoot, ["fetch", "upstream", "--prune"]);
    const behind = git(repoRoot, ["rev-list", "--count", "HEAD..upstream/main"]).stdout;
    if (behind === "0") {
      log("already up to date; nothing to do");
      return { ok: true, steps, noop: true };
    }
    log(`merging upstream/main (${behind} commit(s))`);
    const merge = spawnSync("git", ["merge", "upstream/main", "--no-edit"], { cwd: repoRoot, stdio: "inherit" });
    if (merge.status !== 0) throw new Error("Merge failed or has conflicts. Resolve them by hand; nothing was built or restarted.");
  } else {
    const lock = path.join(repoRoot, "pnpm-lock.yaml");
    const lockBackup = `${lock}.pre-update`;
    fs.copyFileSync(lock, lockBackup);
    try {
      vp(repoRoot, ["i"], nodeExe, "dependency install");
    } catch (error) {
      fs.copyFileSync(lockBackup, lock);
      fs.rmSync(lockBackup, { force: true });
      throw error;
    }
    fs.rmSync(lockBackup, { force: true });
  }

  if (!skipGate) runGate({ repoRoot, nodeExe });

  const staged = stageRelease({ repoRoot, paths, copyExternals: true, nodeExe });
  log(`staged ${staged.dir}`);

  const started = await restartServer({ paths, repoRoot, releaseName: staged.name, keepReleases, nodeExe });
  if (!skipSmoke) {
    const smoke = await runSmoke({
      paths,
      expectRelease: staged.name,
      stableSeconds: 120,
      noTunnel: true,
      nodeExe,
      logFromByte: 0,
    });
    for (const line of smoke.lines) log(line);
    if (!smoke.ok) {
      log("smoke failed; rolling back the binary (database untouched)");
      if (rollback) {
        await restartServer({ paths, repoRoot, releaseName: rollback, keepReleases, nodeExe });
        const again = await runSmoke({ paths, expectRelease: rollback, stableSeconds: 30, noTunnel: true, nodeExe });
        for (const line of again.lines) log(line);
        if (!again.ok) throw new Error("Rollback smoke also failed. A human must look now.");
      }
      throw new Error("Smoke failed after sync; rolled back to the previous release.");
    }
  }
  log(`live on ${staged.name}`);
  return { ok: true, steps, release: staged.name, previous: rollback };
}
