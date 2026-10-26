#!/usr/bin/env node
// The nightly Claude Code update pipeline for Linux.
//
// Same split as nightly.ps1 / nightly-pipeline.ps1 on Windows:
//   preflight  checks the checkout, version and release state, takes a backup,
//              and (dry run) makes a throwaway worktree. Prints one JSON line.
//   ship       launches `pipeline` detached and returns.
//   pipeline   gates the bot's commits, bumps the version, pushes the branch,
//              stages a release and posts the morning report. It NEVER
//              activates or restarts the server: on Linux a staged release
//              goes through the normal gated release path (DevOps).
//
// Safety is the Windows pipeline's: one run at a time, clean checkout, only
// the run's own commits, forbidden paths refused, gate failure reverted with
// new revert commits (never reset/amend/force), risky proposals untouched.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { getPaths, pbHome, repoRootFromScript } from "../node/lib/paths.mjs";
import { backupRoot } from "../node/lib/backup.mjs";
import { activeReleaseName } from "../node/lib/release.mjs";
import { stageRelease } from "../node/lib/build.mjs";
import { runGate } from "../node/lib/upstream.mjs";
import { readJson, readText, utcStamp, writeJsonAtomic } from "../node/lib/util.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = repoRootFromScript(import.meta.url);
const paths = getPaths({ root: "dev" });
const updatesHome = path.join(pbHome(), "claude-code-updates");
const lockFile = path.join(updatesHome, "lock.json");
const tokenFile = path.join(updatesHome, "report-hook-token");
const lastOutcomeFile = path.join(updatesHome, "last-outcome.json");
const dryWorktree = path.join(updatesHome, "dry-worktree");
const snapshotScript = path.join(repoRoot, "scripts", "personal", "sqlite-snapshot.cjs");
const ledgerCli = path.join(repoRoot, "scripts", "personal", "updates", "ledger.ts");
const GIT_IDENTITY = ["-c", "user.email=harout_b5@live.com", "-c", "user.name=haroutB5"];

const ACTIVE_WAITER_STATUSES = new Set([
  "starting",
  "guards",
  "notes_check",
  "evidence_check",
  "preflight",
  "waiting_for_idle",
  "backing_up",
  "activating",
  "smoking",
]);

function parse(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      "run-id": { type: "string" },
      mode: { type: "string", default: "live" },
      "review-label": { type: "string" },
      "review-report": { type: "string" },
    },
  });
  return { command: positionals[0] ?? null, values };
}

function runDirFor(runId) {
  return path.join(updatesHome, "runs", runId);
}

function makeLog(step, runId) {
  const dir = runDirFor(runId);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${step}.log`);
  return {
    file,
    write(text) {
      const line = `${new Date().toISOString().slice(11, 19)} ${text}`;
      fs.appendFileSync(file, `${line}\n`);
      process.stderr.write(`${line}\n`);
    },
  };
}

function git(args, { cwd = repoRoot, allowFail = false } = {}) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0 && !allowFail) {
    throw new Error(`git ${args.join(" ")} failed: ${(result.stderr || "").trim()}`);
  }
  return {
    code: result.status ?? 1,
    stdout: (result.stdout || "").trim(),
    stderr: (result.stderr || "").trim(),
  };
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readLock() {
  return readJson(lockFile);
}

function writeLock(value) {
  fs.mkdirSync(updatesHome, { recursive: true });
  writeJsonAtomic(lockFile, { ...value, updatedAt: new Date().toISOString() });
}

/** Refuses while another run owns the lock; a dead or old run's lock is stale. */
function enterLock(runId, mode, log) {
  const current = readLock();
  if (current && current.runId !== runId) {
    const started = Date.parse(String(current.startedAt ?? ""));
    const stale =
      !pidAlive(Number(current.pid)) || !Number.isFinite(started)
        ? true
        : Date.now() - started > 5 * 60 * 60 * 1000;
    if (!stale) {
      throw new Error(
        `another nightly run is active (${current.runId}, stage ${current.stage}, pid ${current.pid})`,
      );
    }
    log(`replacing the stale lock of run ${current.runId} (pid ${current.pid})`);
  }
  writeLock({
    runId,
    mode,
    stage: "preflight",
    pid: process.pid,
    startedAt: current?.runId === runId ? current.startedAt : new Date().toISOString(),
  });
}

function exitLock(runId) {
  const current = readLock();
  if (current?.runId === runId) fs.rmSync(lockFile, { force: true });
}

function assertLockOwner(runId, log) {
  const current = readLock();
  if (!current || current.runId !== runId) {
    throw new Error(`no lock for run ${runId}; preflight did not complete`);
  }
  if (
    current.pid !== process.pid &&
    pidAlive(Number(current.pid)) &&
    current.stage === "pipeline"
  ) {
    log(`another pipeline owns the lock (pid ${current.pid})`);
    throw new Error(`run ${runId} is already in its pipeline`);
  }
  writeLock({ ...current, stage: "pipeline", pid: process.pid });
}

function isNotInRelease(changedPath) {
  const p = changedPath.replace(/\\/g, "/").trim();
  if (p === "scripts/personal/app-version.txt") return false;
  if (/^[^/]+\.md$/.test(p)) return true;
  if (p.startsWith("docs/")) return true;
  if (p.startsWith("scripts/personal/")) return true;
  return false;
}

function forbiddenPaths(changed) {
  return changed
    .map((p) => p.replace(/\\/g, "/"))
    .filter(
      (p) =>
        /(^|\/)\.env($|\.)/.test(p) ||
        /(^|\/)secrets\//.test(p) ||
        p === "scripts/personal/app-version.txt",
    );
}

function versionParts(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(version).trim());
  return match ? match.slice(1).map(Number) : null;
}

function compareVersions(a, b) {
  const left = versionParts(a);
  const right = versionParts(b);
  if (!left || !right) return 0;
  for (let index = 0; index < 3; index++) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

function nextPatch(version) {
  const parts = versionParts(version);
  if (!parts) throw new Error(`app-version.txt is not x.y.z: ${version}`);
  return `${parts[0]}.${parts[1]}.${parts[2] + 1}`;
}

function readVersionFile(file) {
  return (readText(file) ?? "").split(/\r?\n/)[0].trim();
}

function readLiveRelease() {
  const name = activeReleaseName(paths);
  if (!name) throw new Error(`no live release (${paths.currentFile} is empty)`);
  const versionText = readText(path.join(paths.releasesDir, name, "VERSION"));
  if (versionText === null) throw new Error(`live release ${name} has no VERSION file`);
  const values = new Map();
  for (const line of versionText.split(/\r?\n/)) {
    const at = line.indexOf("=");
    if (at > 0) values.set(line.slice(0, at).trim(), line.slice(at + 1).trim());
  }
  return {
    name,
    version: values.get("version") ?? null,
    sha: values.get("sha") ?? null,
    branch: values.get("branch") ?? null,
    repo: values.get("repo") ?? null,
    externals: values.get("externals") ?? null,
  };
}

function reservedVersions(live) {
  const reserved = new Set();
  if (live.version) reserved.add(live.version);
  let entries = [];
  try {
    entries = fs
      .readdirSync(paths.releasesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory());
  } catch {
    return reserved;
  }
  for (const entry of entries) {
    const dir = path.join(paths.releasesDir, entry.name);
    const versionText = readText(path.join(dir, "VERSION")) ?? "";
    const value = /^version=(.+)$/m.exec(versionText)?.[1]?.trim() ?? "";
    if (!versionParts(value)) continue;
    let ageDays = 0;
    try {
      ageDays = (Date.now() - fs.statSync(dir).mtimeMs) / 86_400_000;
    } catch {
      ageDays = 0;
    }
    const resultFile = path.join(paths.runDir, `restart-${value}-result.json`);
    if (fs.existsSync(resultFile)) {
      const result = readJson(resultFile);
      if (result && !ACTIVE_WAITER_STATUSES.has(String(result.status))) continue;
    }
    if (entry.name === live.name || ageDays <= 14) reserved.add(value);
  }
  return reserved;
}

function assertVersionFree(version, live) {
  const reserved = reservedVersions(live);
  if (reserved.has(version)) {
    throw new Error(`version ${version} is already staged or in use (${[...reserved].join(", ")})`);
  }
}

function ensureDependencies(log) {
  const lock = path.join(repoRoot, "pnpm-lock.yaml");
  const modules = path.join(repoRoot, "node_modules");
  if (!fs.existsSync(lock) || !fs.existsSync(modules)) {
    throw new Error(`dependencies are not installed in ${repoRoot} (vp i first)`);
  }
  const wanted = fs.readFileSync(lock);
  const installedPath = path.join(modules, ".pnpm", "lock.yaml");
  const installed = fs.existsSync(installedPath) ? fs.readFileSync(installedPath) : null;
  if (installed && Buffer.compare(wanted, installed) === 0) return;
  log("node_modules do not match pnpm-lock.yaml; vp i in the checkout");
  const vp = path.join(modules, ".bin", "vp");
  // Keep stdout clean: the bot reads exactly one JSON line from preflight.
  const result = spawnSync(vp, ["i"], {
    cwd: repoRoot,
    stdio: ["ignore", 2, 2],
    timeout: 30 * 60 * 1000,
  });
  if (result.status !== 0) throw new Error(`vp i failed (exit ${result.status})`);
}

async function postReportAsync(text) {
  if (process.env.PB_UPDATES_NO_REPORT) return false;
  const token = readText(tokenFile)?.trim();
  if (!token) return false;
  const body = JSON.stringify({
    message: text.length > 7900 ? `${text.slice(0, 7890)} [...]` : text,
  });
  const deadline = Date.now() + 10 * 60 * 1000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:38472/api/personal/hooks/${token}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        signal: AbortSignal.timeout(20_000),
      });
      if (response.status === 202) return true;
      if (response.status === 404) return false;
    } catch {
      // Server not up yet; retry.
    }
    await new Promise((resolve) => setTimeout(resolve, 35_000));
  }
  return false;
}

function runLedger(ledger, runId, args) {
  const result = spawnSync(
    process.execPath,
    [
      "--disable-warning=ExperimentalWarning",
      ledgerCli,
      "--ledger",
      ledger,
      "--run",
      runId,
      ...args,
    ],
    { cwd: updatesHome, encoding: "utf8" },
  );
  return {
    code: result.status ?? 1,
    stdout: (result.stdout || "").trim(),
    stderr: (result.stderr || "").trim(),
  };
}

function ledgerJson(ledger, runId, args, log) {
  const result = runLedger(ledger, runId, args);
  if (result.code !== 0) {
    log(`ledger ${args.join(" ")} failed: ${result.stderr}`);
    return null;
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

async function finish(run, outcome, log) {
  const runDir = runDirFor(run.runId);
  const outcomeFile = path.join(runDir, "outcome.json");
  const final = {
    runId: run.runId,
    mode: run.mode,
    ...outcome,
    review:
      run.reviewLabel && run.reviewReport
        ? { label: run.reviewLabel, reportFile: run.reviewReport }
        : null,
    finishedAt: new Date().toISOString(),
  };
  writeJsonAtomic(outcomeFile, final);
  const report = runLedger(run.ledger, run.runId, ["report", "--outcome", outcomeFile]);
  const text =
    report.code === 0 && report.stdout ? report.stdout : `${final.summary}\n\nRun ${run.runId}.`;
  fs.writeFileSync(path.join(runDir, "report.md"), `${text}\n`);
  const posted = await postReportAsync(text);
  const stored = { ...final, reported: posted };
  writeJsonAtomic(lastOutcomeFile, stored);
  log(posted ? "morning report posted" : "morning report NOT posted (hook unavailable)");
  exitLock(run.runId);
  return posted;
}

async function repostPrevious(log) {
  const previous = readJson(lastOutcomeFile);
  if (!previous || previous.reported) return;
  const report = readText(path.join(runDirFor(String(previous.runId)), "report.md"));
  if (!report) return;
  log(`re-posting run ${previous.runId}'s report, which never reached the chat`);
  const posted = await postReportAsync(`(Delivered late) ${report.trim()}`);
  if (posted) writeJsonAtomic(lastOutcomeFile, { ...previous, reported: true });
}

function uniqueDirEntries(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/**
 * A dry run gets a throwaway worktree. Point its node_modules at the real
 * install, then re-point the workspace packages so tests see the worktree's
 * source, not the checkout's.
 */
function linkNodeModules(sourceRepo, targetRepo) {
  const skip = new Set([".git", ".repos", "dist", "node_modules"]);
  const queue = [""];
  while (queue.length > 0) {
    const rel = queue.shift();
    const sourceDir = path.join(sourceRepo, rel);
    for (const entry of uniqueDirEntries(sourceDir)) {
      if (!entry.isDirectory()) continue;
      const childRel = path.join(rel, entry.name);
      if (entry.name === "node_modules") {
        const target = path.join(targetRepo, childRel);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.rmSync(target, { recursive: true, force: true });
        fs.symlinkSync(path.join(sourceRepo, childRel), target, "dir");
        continue;
      }
      if (skip.has(entry.name)) continue;
      if (childRel.split(path.sep).length > 4) continue;
      queue.push(childRel);
    }
  }
  const workspaceDirs = [
    ...uniqueDirEntries(path.join(sourceRepo, "packages")).map((entry) =>
      path.join("packages", entry.name),
    ),
    ...uniqueDirEntries(path.join(sourceRepo, "apps")).map((entry) =>
      path.join("apps", entry.name),
    ),
  ];
  for (const rel of workspaceDirs) {
    const manifest = readJson(path.join(sourceRepo, rel, "package.json"));
    if (!manifest?.name) continue;
    const target = path.join(targetRepo, "node_modules", manifest.name);
    const exists = fs.existsSync(path.join(sourceRepo, "node_modules", manifest.name));
    if (!exists) continue;
    fs.rmSync(target, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.symlinkSync(path.join(targetRepo, rel), target, "dir");
  }
}

function prepareDryWorktree(head, log) {
  fs.rmSync(dryWorktree, { recursive: true, force: true });
  git(["worktree", "prune"]);
  log(`creating the dry-run worktree at ${dryWorktree}`);
  git(["worktree", "add", "--detach", "--quiet", dryWorktree, head]);
  const envFile = path.join(repoRoot, ".env");
  if (fs.existsSync(envFile)) fs.copyFileSync(envFile, path.join(dryWorktree, ".env"));
  log("linking node_modules into the dry-run worktree");
  linkNodeModules(repoRoot, dryWorktree);
}

function checkClean(workDir) {
  const dirty = git(["status", "--porcelain", "--untracked-files=no"], { cwd: workDir }).stdout;
  if (dirty) {
    throw new Error(
      `the checkout has uncommitted change(s) (someone is working in it): ${dirty.split("\n").slice(0, 5).join(", ")}`,
    );
  }
}

async function preflight(runId, mode, reviewLabel, reviewReport) {
  const log = makeLog("preflight", runId);
  let lockTaken = false;
  try {
    await repostPrevious(log);
    enterLock(runId, mode, log);
    lockTaken = true;
    log(`preflight run ${runId} (${mode}), checkout ${repoRoot}`);

    const live = readLiveRelease();
    const branch = process.env.HBOTS_UPDATES_BRANCH ?? live.branch ?? "personal-bots/main";
    const current = git(["rev-parse", "--abbrev-ref", "HEAD"]).stdout;
    if (current !== branch) throw new Error(`the checkout is on '${current}', not ${branch}`);
    checkClean(repoRoot);

    if (git(["remote"], { allowFail: true }).stdout.split(/\r?\n/).includes("origin")) {
      git(["fetch", "origin", "--prune"]);
      const origin = git(["rev-parse", "--verify", "--quiet", `origin/${branch}`], {
        allowFail: true,
      });
      if (origin.code === 0) {
        const head = git(["rev-parse", "HEAD"]).stdout;
        const ahead = Number(git(["rev-list", "--count", `origin/${branch}..HEAD`]).stdout || 0);
        const behind = Number(git(["rev-list", "--count", `HEAD..origin/${branch}`]).stdout || 0);
        if (ahead === 0 && behind > 0) {
          log(`the checkout is ${behind} commit(s) behind origin/${branch}; fast-forwarding`);
          git(["merge", "--ff-only", "--quiet", `origin/${branch}`]);
          if (git(["rev-parse", "HEAD"]).stdout !== origin.stdout) {
            throw new Error(`the fast-forward onto origin/${branch} did not land`);
          }
        } else if (ahead > 0 && behind > 0) {
          throw new Error(
            `the checkout is ${ahead} commit(s) ahead of and ${behind} behind origin/${branch}`,
          );
        } else if (head !== origin.stdout) {
          log(`the checkout is ${ahead} commit(s) ahead of origin/${branch}`);
        }
      }
    }

    const head = git(["rev-parse", "HEAD"]).stdout;
    if (!live.sha) throw new Error(`live release ${live.name} does not name its commit`);
    const liveCommit = git(["rev-parse", "--verify", "--quiet", `${live.sha}^{commit}`], {
      allowFail: true,
    });
    if (liveCommit.code !== 0) {
      throw new Error(`the live release ${live.name} is not a commit in this checkout's history`);
    }
    const changed = git(["diff", "--name-only", "--no-renames", liveCommit.stdout, "HEAD", "--"])
      .stdout.split(/\r?\n/)
      .filter(Boolean);
    const code = changed.filter((p) => !isNotInRelease(p));
    if (code.length > 0) {
      throw new Error(
        `HEAD has code changes that are not live (live release ${live.name}; ${code.length} path(s), first: ${code.slice(0, 5).join(", ")})`,
      );
    }
    log(
      `HEAD ${head.slice(0, 10)} holds no code the live release ${live.name} lacks (${changed.length} notes/tooling path(s) differ)`,
    );

    const next = nextPatch(
      readVersionFile(path.join(repoRoot, "scripts", "personal", "app-version.txt")),
    );
    const originVersion = git(["show", `origin/${branch}:scripts/personal/app-version.txt`], {
      allowFail: true,
    });
    const candidate =
      originVersion.code === 0 && versionParts(originVersion.stdout)
        ? compareVersions(originVersion.stdout, next) > 0
          ? nextPatch(originVersion.stdout)
          : next
        : next;
    assertVersionFree(candidate, live);
    log(`version ${candidate} is free and no release is in flight`);

    ensureDependencies(log);

    let backupLine = "backup skipped (dry run)";
    if (mode === "live") {
      log("database backup ...");
      const backup = backupRoot({ paths, keep: 1, snapshotScript });
      backupLine = `Backup written: ${backup.target}`;
      log(backupLine);
    }

    const workDir = mode === "dry-run" ? dryWorktree : repoRoot;
    let ledger = path.join(
      paths.home,
      "personal-bots-notes",
      "claude-code-updates",
      "proposals.json",
    );
    const notesEnv = process.env.PB_NOTES_DIR;
    if (notesEnv) ledger = path.join(notesEnv, "claude-code-updates", "proposals.json");
    else if (process.platform !== "win32") {
      ledger = path.join(
        os.homedir(),
        "Claude",
        "AI",
        "personal-bots-notes",
        "claude-code-updates",
        "proposals.json",
      );
    }
    if (mode === "dry-run") {
      prepareDryWorktree(head, log);
      const copy = path.join(runDirFor(runId), "proposals.json");
      fs.mkdirSync(path.dirname(copy), { recursive: true });
      if (fs.existsSync(ledger)) fs.copyFileSync(ledger, copy);
      ledger = copy;
    }

    const untracked = git(["ls-files", "--others", "--exclude-standard"], { cwd: workDir })
      .stdout.split(/\r?\n/)
      .filter(Boolean);
    const run = {
      runId,
      mode,
      repo: repoRoot,
      workDir,
      baseSha: head,
      ledger,
      liveRelease: live.name,
      liveVersion: live.version,
      liveBranch: branch,
      reviewLabel: reviewLabel ?? null,
      reviewReport: reviewReport ?? null,
      untracked,
      backup: backupLine,
      startedAt: new Date().toISOString(),
    };
    fs.mkdirSync(runDirFor(runId), { recursive: true });
    fs.writeFileSync(path.join(runDirFor(runId), "run.json"), `${JSON.stringify(run, null, 2)}\n`);
    writeLock({ runId, mode, stage: "bot", pid: process.pid, startedAt: run.startedAt });
    log(`preflight ok: workDir ${workDir}, base ${head.slice(0, 10)}, live ${live.name}`);
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        runId,
        mode,
        workDir: workDir.replace(/\\/g, "/"),
        baseSha: head,
        ledger: ledger.replace(/\\/g, "/"),
        dependencyChangesAllowed: true,
        liveRelease: live.name,
      })}\n`,
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    log(`preflight refused: ${reason}`);
    const outcome = {
      result: "preflight-blocked",
      summary: `The run stopped at preflight: ${reason}. Nothing was changed, pushed or restarted.`,
      version: null,
      release: null,
      previousRelease: null,
      steps: [`preflight: ${reason}`],
      urgent: false,
    };
    const run = {
      runId,
      mode,
      ledger: path.join(
        os.homedir(),
        "Claude",
        "AI",
        "personal-bots-notes",
        "claude-code-updates",
        "proposals.json",
      ),
      reviewLabel: reviewLabel ?? null,
      reviewReport: reviewReport ?? null,
    };
    await finish(run, outcome, log);
    if (lockTaken) exitLock(runId);
    if (mode === "dry-run") fs.rmSync(dryWorktree, { recursive: true, force: true });
    process.stdout.write(`${JSON.stringify({ ok: false, runId, reason })}\n`);
    process.exitCode = 1;
  }
}

function ship(runId) {
  const run = readJson(path.join(runDirFor(runId), "run.json"));
  if (!run) throw new Error(`no preflight record for run ${runId}`);
  assertLockOwner(runId, () => {});
  const logPath = path.join(runDirFor(runId), "pipeline.log");
  const fd = fs.openSync(logPath, "a");
  const child = spawn(
    process.execPath,
    [fileURLToPath(import.meta.url), "pipeline", "--run-id", runId],
    {
      cwd: updatesHome,
      detached: true,
      stdio: ["ignore", fd, fd],
    },
  );
  child.unref();
  writeLock({ ...readLock(), stage: "pipeline", pid: child.pid });
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      runId,
      pipelinePid: child.pid,
      log: logPath.replace(/\\/g, "/"),
      next: "The gates, build and stage run on their own now; the morning report follows.",
    })}\n`,
  );
}

function revertRun(workDir, commits, log) {
  const created = [];
  for (const sha of [...commits].reverse()) {
    const parents = git(["rev-list", "--parents", "-n", "1", sha], { cwd: workDir }).stdout.split(
      " ",
    );
    if (parents.length > 2)
      throw new Error(`commit ${sha} is a merge; not reverting it automatically`);
    const result = git([...GIT_IDENTITY, "revert", "--no-edit", sha], {
      cwd: workDir,
      allowFail: true,
    });
    if (result.code !== 0) {
      git(["revert", "--abort"], { cwd: workDir, allowFail: true });
      throw new Error(`git revert ${sha} did not apply cleanly: ${result.stderr}`);
    }
    created.push(git(["rev-parse", "--short=10", "HEAD"], { cwd: workDir }).stdout);
  }
  log(`reverted ${commits.length} commit(s) with ${created.length} revert commit(s)`);
  return created;
}

async function pipeline(runId) {
  const log = makeLog("pipeline", runId);
  const run = readJson(path.join(runDirFor(runId), "run.json"));
  if (!run) {
    log(`no run record for ${runId}`);
    process.exitCode = 1;
    return;
  }
  const workDir = String(run.workDir);
  const live = run.mode === "live";
  let pushed = false;
  let outcome = null;
  try {
    assertLockOwner(runId, log);
    log(
      `pipeline run ${runId} (${run.mode}), workDir ${workDir}, base ${String(run.baseSha).slice(0, 10)}`,
    );

    checkClean(workDir);
    const base = String(run.baseSha);
    const commits = git(["rev-list", "--reverse", `${base}..HEAD`], { cwd: workDir })
      .stdout.split(/\r?\n/)
      .filter(Boolean);
    if (commits.length === 0) {
      outcome = {
        result: "nothing-applied",
        summary: "Nothing was applied this time, so nothing was built or staged.",
        version: null,
        release: null,
        previousRelease: run.liveRelease ?? null,
        steps: ["no commits: no gates, build or stage needed"],
        urgent: false,
      };
      await finish(run, outcome, log);
      return;
    }

    const recorded = ledgerJson(run.ledger, runId, ["run-commits"], log) ?? [];
    const recordedShas = recorded
      .flatMap((entry) => entry.commits ?? [])
      .map((sha) => String(sha).toLowerCase());
    const foreign = commits.filter(
      (sha) => !recordedShas.some((short) => sha.toLowerCase().startsWith(short)),
    );
    if (foreign.length > 0) {
      outcome = {
        result: "error",
        summary: `${foreign.length} commit(s) since the run started are not recorded by any proposal (${foreign.map((sha) => sha.slice(0, 10)).join(", ")}): someone else committed in the checkout, or the bot did not record them. Nothing was gated, pushed or reverted.`,
        version: null,
        release: null,
        previousRelease: run.liveRelease ?? null,
        steps: [`unrecorded commits: ${foreign.map((sha) => sha.slice(0, 10)).join(", ")}`],
        urgent: false,
      };
      await finish(run, outcome, log);
      return;
    }
    log(
      `${commits.length} commit(s) from the bot: ${commits.map((sha) => sha.slice(0, 10)).join(", ")}`,
    );

    const changed = git(["diff", "--name-only", `${base}..HEAD`], { cwd: workDir })
      .stdout.split(/\r?\n/)
      .filter(Boolean);
    const forbidden = forbiddenPaths(changed);
    if (forbidden.length > 0) {
      revertRun(workDir, commits, log);
      runLedger(run.ledger, runId, [
        "run-reverted",
        "--reason",
        `touched forbidden files (${forbidden.join(", ")})`,
      ]);
      outcome = {
        result: "gates-red",
        summary: `The run's commits touched files the bot must never change (${forbidden.join(", ")}); they were reverted.`,
        version: null,
        release: null,
        previousRelease: run.liveRelease ?? null,
        steps: [`forbidden paths: ${forbidden.join(", ")}`],
        urgent: false,
      };
      await finish(run, outcome, log);
      return;
    }

    log("gates: server personal tests, server tsc, web personal tests");
    const previousNodeEnv = process.env.NODE_ENV;
    try {
      // React's test renderer exposes act only in a test build. The Bots server
      // runs with NODE_ENV=production and the pipeline inherits it.
      process.env.NODE_ENV = "test";
      runGate({ repoRoot: workDir, nodeExe: process.execPath });
      log("gates green");
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      log(`gates red: ${reason}`);
      revertRun(workDir, commits, log);
      runLedger(run.ledger, runId, [
        "run-reverted",
        "--reason",
        `gates red: ${reason.slice(0, 300)}`,
      ]);
      outcome = {
        result: "gates-red",
        summary:
          "The gates were red after the bot's changes, so every change of this run was reverted with new revert commits. Nothing was built or staged.",
        version: null,
        release: null,
        previousRelease: run.liveRelease ?? null,
        steps: [`gates red: ${reason}`],
        urgent: false,
      };
      await finish(run, outcome, log);
      return;
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
    }

    const versionFile = path.join(workDir, "scripts", "personal", "app-version.txt");
    const oldVersion = readVersionFile(versionFile);
    const originVersion = git(
      ["show", `origin/${run.liveBranch ?? "personal-bots/main"}:scripts/personal/app-version.txt`],
      {
        cwd: workDir,
        allowFail: true,
      },
    );
    const baseVersion =
      originVersion.code === 0 &&
      versionParts(originVersion.stdout) &&
      compareVersions(originVersion.stdout, oldVersion) > 0
        ? originVersion.stdout
        : oldVersion;
    const version = nextPatch(baseVersion);
    assertVersionFree(version, readLiveRelease());
    fs.writeFileSync(versionFile, `${version}\n`);
    const ids = recorded.map((entry) => entry.id).filter(Boolean);
    const idText = ids.length > 0 ? ` (${ids.join(", ")})` : "";
    git(["add", "scripts/personal/app-version.txt"], { cwd: workDir });
    git(
      [
        ...GIT_IDENTITY,
        "commit",
        "-m",
        `release ${version}: nightly Claude Code update${idText}`,
        "-m",
        `Automated by scripts/personal/updates/nightly.mjs (run ${runId}).`,
      ],
      { cwd: workDir },
    );
    log(`version ${oldVersion} -> ${version}`);

    if (live) {
      const push = git(["push", "origin", `HEAD:refs/heads/${run.liveBranch}`], {
        cwd: workDir,
        allowFail: true,
      });
      if (push.code !== 0) {
        outcome = {
          result: "push-rejected",
          summary: `Gates were green but origin/${run.liveBranch} moved, so the push was rejected (never forced). Nothing was built; the commits stay local in ${workDir}.`,
          version,
          release: null,
          previousRelease: run.liveRelease ?? null,
          steps: [`push rejected: ${push.stderr}`],
          urgent: false,
        };
        await finish(run, outcome, log);
        return;
      }
      pushed = true;
      log(`pushed to origin/${run.liveBranch}`);
    }

    let staged;
    try {
      staged = stageRelease({
        repoRoot: workDir,
        paths,
        copyExternals: true,
        nodeExe: process.execPath,
        builtAt: new Date(),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      log(`build failed: ${reason}`);
      revertRun(
        workDir,
        commits.concat([git(["rev-parse", "HEAD"], { cwd: workDir }).stdout]),
        log,
      );
      if (pushed)
        git(["push", "origin", `HEAD:refs/heads/${run.liveBranch}`], {
          cwd: workDir,
          allowFail: true,
        });
      runLedger(run.ledger, runId, [
        "run-reverted",
        "--reason",
        `build failed: ${reason.slice(0, 300)}`,
      ]);
      outcome = {
        result: "build-failed",
        summary:
          "The build failed, so every change of this run (and the version bump) was reverted and pushed. Nothing was activated.",
        version: null,
        release: null,
        previousRelease: run.liveRelease ?? null,
        steps: [`build failed: ${reason}`],
        urgent: false,
      };
      await finish(run, outcome, log);
      return;
    }
    log(`staged release ${staged.name} with its own externals (not active)`);

    if (run.mode === "dry-run") {
      const releaseDir = path.join(paths.releasesDir, staged.name);
      const modules = path.join(releaseDir, "node_modules");
      try {
        if (fs.lstatSync(modules).isSymbolicLink()) fs.unlinkSync(modules);
      } catch {
        // No externals folder or already gone.
      }
      fs.rmSync(releaseDir, { recursive: true, force: true });
      revertRun(
        workDir,
        commits.concat([git(["rev-parse", "HEAD"], { cwd: workDir }).stdout]),
        log,
      );
      fs.rmSync(dryWorktree, { recursive: true, force: true });
      git(["worktree", "prune"]);
      outcome = {
        result: "dry-run",
        summary:
          "Rehearsal only: the gate passed and the release built, then the commits and the rehearsal release were removed. Nothing was pushed, staged or activated.",
        version,
        release: null,
        previousRelease: run.liveRelease ?? null,
        steps: ["gates green", `built and removed rehearsal release ${staged.name}`],
        urgent: false,
      };
      await finish(run, outcome, log);
      return;
    }

    outcome = {
      result: "staged",
      summary: `Gated and staged release ${staged.name} for the normal release path. Nothing was activated or restarted; DevOps releases it.`,
      version,
      release: staged.name,
      previousRelease: run.liveRelease ?? null,
      steps: [
        "gates green",
        `pushed origin/${run.liveBranch}`,
        `staged release ${staged.name} with copied externals (not active)`,
      ],
      urgent: false,
    };
    await finish(run, outcome, log);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    log(`pipeline stopped: ${reason}`);
    const failed = {
      result: "error",
      summary: `The pipeline stopped on an error: ${reason}. Check the log before retrying.`,
      version: null,
      release: null,
      previousRelease: run.liveRelease ?? null,
      steps: [`error: ${reason}`],
      urgent: false,
    };
    try {
      await finish(run, failed, log);
    } catch (finishError) {
      log(
        `could not record the outcome: ${finishError instanceof Error ? finishError.message : String(finishError)}`,
      );
      exitLock(runId);
    }
    process.exitCode = 1;
  }
}

async function main() {
  const { command, values } = parse(process.argv.slice(2));
  const runId = values["run-id"];
  if (!command || !runId || !/^[0-9A-Za-z-]+$/.test(runId)) {
    process.stderr.write(
      "usage: nightly.mjs <preflight|ship|pipeline> --run-id <id> [--mode live|dry-run]\n",
    );
    return 2;
  }
  const mode = values.mode === "dry-run" ? "dry-run" : "live";
  if (command === "preflight") {
    await preflight(runId, mode, values["review-label"], values["review-report"]);
    return 0;
  }
  if (command === "ship") {
    ship(runId);
    return 0;
  }
  if (command === "pipeline") {
    await pipeline(runId);
    return 0;
  }
  process.stderr.write(`unknown command: ${command}\n`);
  return 2;
}

main()
  .then((code) => process.exit(code ?? 0))
  .catch((error) => {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
