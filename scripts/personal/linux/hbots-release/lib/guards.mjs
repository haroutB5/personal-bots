// Every guard of the release runner, in the Windows runner's order. Each throws with a plain message.
import fs from "node:fs";
import path from "node:path";
import { run, runAsync, readJson, systemctl, errMsg } from "./util.mjs";
import { checkPins } from "./pins.mjs";
import { verifySeal } from "./seal.mjs";
import { cgroupOfPid, liveState, procSnapshot } from "./proc.mjs";
import { diskPlan, fixtureBackupProof, listBackups, reflinkProbe } from "./backup.mjs";
import { makeFixtureDb } from "./fixture.mjs";

export function gitShow(repo, rev, file) {
  const r = run("git", ["-C", repo, "show", `${rev}:${file}`], { timeout: 60_000 });
  return r.code === 0 ? r.out : null;
}

export function migrationIds(text) {
  return [...text.matchAll(/^\s*\[\s*(\d+)\s*,/gm)].map((m) => Number(m[1]));
}

export function maxMigration(repo, rev) {
  const text = gitShow(repo, rev, "apps/server/src/persistence/Migrations.ts");
  if (text === null) return null;
  const ids = migrationIds(text);
  return ids.length ? Math.max(...ids) : null;
}

export function testConcurrencyRule(a) {
  const text = gitShow(a["repo-root"], a["main-sha"], "apps/server/src/personal/tasks/PersonalTaskService.ts");
  if (text === null) throw new Error(`Cannot read PersonalTaskService.ts at ${a["main-sha"]} to prove PERSONAL_TASKS_CONCURRENCY = 5.`);
  if (!/PERSONAL_TASKS_CONCURRENCY\s*=\s*5\b/.test(text)) throw new Error(`PERSONAL_TASKS_CONCURRENCY is not 5 at ${a["main-sha"]} (Harout's rule: at most 5 at once in total).`);
}

/** Migration levels come from git source only: the live database is never opened. */
export function testMigrations(a) {
  const after = maxMigration(a["repo-root"], a["main-sha"]);
  if (after === null) throw new Error(`Cannot read Migrations.ts at ${a["main-sha"]} from ${a["repo-root"]}; -migration-after cannot be verified. Nothing was restarted.`);
  if (after !== Number(a["migration-after"])) throw new Error(`Migrations.ts at ${a["main-sha"]} tops out at ${after}, but --migration-after is ${a["migration-after"]}. Nothing was restarted.`);
  const before = maxMigration(a["repo-root"], a.rollback);
  if (before === null) throw new Error(`Cannot read Migrations.ts at the rollback release ${a.rollback} from ${a["repo-root"]}; --migration-before cannot be verified.`);
  if (before !== Number(a["migration-before"])) throw new Error(`Migrations.ts at the rollback release ${a.rollback} tops out at ${before}, but --migration-before is ${a["migration-before"]}.`);
  return { before, after };
}

export function testActiveRelease(cfg, a, { allowTarget = false } = {}) {
  let cur = "";
  try {
    cur = fs.readFileSync(cfg.currentTxt, "utf8").trim();
  } catch {}
  const server = readJson(cfg.serverJson);
  const ok = [a.rollback];
  if (allowTarget) ok.push(a.release);
  if (!ok.includes(cur) || !ok.includes(String(server?.release))) {
    throw new Error(`Active release changed (current.txt=${cur}, server.json=${server?.release}); expected the live baseline ${a.rollback}. Not activating.`);
  }
  return cur;
}

/** Other release waiters: transient hbots-release-run-* units, a legacy waiter script, or another runner in run mode. */
export function otherRunners(cfg) {
  if (cfg.test) return [];
  const found = [];
  const own = (fs.readFileSync("/proc/self/cgroup", "utf8").trim().split("\n").pop().split("/").pop() ?? "");
  const units = run("systemctl", ["--user", "list-units", "--type=service", "--state=running", "hbots-release-run-*", "--no-legend", "--no-pager"], { timeout: 20_000 });
  for (const line of units.out.split("\n")) {
    const name = line.trim().split(/\s+/)[0];
    if (name?.endsWith(".service") && name !== own) found.push(name);
  }
  for (const p of procSnapshot().values()) {
    if (p.pid === process.pid || p.pid === process.ppid) continue;
    if (/linux-release-\d+\.\d+\.\d+\.mjs/.test(p.cmdline) && !found.includes(`pid ${p.pid}`)) found.push(`pid ${p.pid}`);
  }
  return found;
}

export function testRunnerOutsideUnit(cfg) {
  if (cfg.test) return;
  const mine = cgroupOfPid(process.pid) ?? "";
  if (mine.includes(cfg.unit)) throw new Error(`The runner is inside ${cfg.unit}'s cgroup (${mine}); the restart would kill it. Start it with the launcher (systemd-run --user).`);
}

export function toolPath(cfg, name) {
  return path.join(cfg.toolsDir, name);
}

export async function runTool(cfg, name, args) {
  return runAsync(cfg.node, [toolPath(cfg, name), ...args], { timeoutMs: 5 * 60_000 });
}

export function smokeCli(cfg, names) {
  if (cfg.cli) return cfg.cli;
  return path.join(names.tools, "scripts", "personal", "node", "hbots.mjs");
}

/**
 * Runs every guard. `ctx` supplies note/save/step/result. Order matches the Windows runner:
 * pinned-helpers, seal-and-artifact, concurrency-rule, notes-check, evidence-check, backup or migration,
 * active-release, no-other-waiter (run mode), plus the Linux-only unit and cgroup checks.
 */
export async function runGuards(cfg, a, names, ctx, flags) {
  const { note, save, step, result } = ctx;
  const mode = names.mode;
  await step("guards.pinned-helpers", async () => {
    const n = checkPins(cfg);
    note(`Pinned helpers match (${n} files).`);
  });
  await step("guards.unit-and-cli", async () => {
    const show = run("systemctl", ["--user", "show", cfg.unit, "-p", "LoadState", "-p", "ActiveState", "--value"], { timeout: 15_000 });
    const [load, active] = show.out.split("\n");
    if (load !== "loaded") throw new Error(`Unit ${cfg.unit} is not loaded (${show.out.replace(/\n/g, " ")}).`);
    if (active !== "active") throw new Error(`Unit ${cfg.unit} is ${active}; the baseline is not running.`);
    const state = liveState(cfg);
    if (!state) throw new Error("The recorded server process is not running (server.json pid does not match a live serve process).");
    const cli = smokeCli(cfg, names);
    if (!fs.existsSync(cli)) throw new Error(`Smoke CLI missing: ${cli}.`);
    if (!fs.existsSync(cfg.node)) throw new Error(`Pinned node missing: ${cfg.node}.`);
    testRunnerOutsideUnit(cfg);
    result.smokeCli = cli;
    result.serverCgroup = cgroupOfPid(Number(state.pid));
  });
  await step("guards.seal-and-artifact", async () => {
    flags.seal = await verifySeal(cfg, a, names, { legacyNoEvidence: a["legacy-no-evidence"] && mode !== "run" });
  });
  await step("guards.concurrency-rule", async () => testConcurrencyRule(a));
  save("notes_check");
  await step("guards.notes-check", async () => {
    const r = await runTool(cfg, "check-release-notes.mjs", ["--version", a.version, "--commit", a["main-sha"], "--repo-root", a["repo-root"]]);
    result.notesExit = r.code;
    note(`check-release-notes exit=${r.code} ${r.out || r.err}`.slice(0, 400));
    if (r.code !== 0) throw new Error(`check-release-notes exited ${r.code} (${(r.err || r.out).slice(0, 200)}); not arming the restart (nothing was restarted). Finish docs/releases/HANDOFF-<ver>.md, push it, and re-arm.`);
  });
  save("evidence_check");
  await step("guards.evidence-check", async () => {
    if (a["legacy-no-evidence"] && mode !== "run") {
      result.evidenceExit = null;
      result.evidenceSkipped = "legacy release without gate evidence (read-only modes only)";
      note("Gate evidence check skipped: --legacy-no-evidence, read-only mode.");
      return;
    }
    const r = await runTool(cfg, "check-gate-evidence.mjs", ["--version", a.version, "--release", a.release, "--commit", a["main-sha"], "--repo-root", a["repo-root"], "--releases-dir", cfg.releases]);
    result.evidenceExit = r.code;
    note(`check-gate-evidence exit=${r.code} ${r.out || r.err}`.slice(0, 600));
    if (r.code !== 0) throw new Error(`check-gate-evidence exited ${r.code} (${(r.err || r.out).slice(0, 300)}); not arming the restart (nothing was restarted). Run gate-evidence on the staged release, commit the notes (docs/releases only), push, and re-arm.`);
  });
  save("preflight");
  const levels = await step("guards.migrations", async () => testMigrations(a));
  result.migrationLevelsFromSource = levels;
  const skipBackup = Number(a["migration-before"]) === Number(a["migration-after"]) && !a["force-backup"];
  result.backupSkipped = skipBackup;
  result.backupDecision = skipBackup ? "no migration (backup skipped; the live database is not opened)" : a["force-backup"] && levels.before === levels.after ? "--force-backup" : `migration ${levels.before} -> ${levels.after}`;
  if (!skipBackup) {
    await step("guards.reflink-and-disk", async () => {
      const probe = reflinkProbe(cfg);
      const disk = diskPlan(cfg, probe.ok, a["allow-slow-backup"]);
      result.reflink = probe.ok;
      result.diskFreeBytes = disk.free;
      result.diskNeededBytes = disk.need;
      result.liveFileSizes = disk.sizes;
      if (!probe.ok && !a["allow-slow-backup"]) throw new Error(`Reflink copy is not available (${probe.reason}). A full copy of the database would keep the server stopped for minutes; pass --allow-slow-backup to accept that.`);
      if (disk.free < disk.need) throw new Error(`Not enough disk space for the backup: ${(disk.free / 1024 ** 3).toFixed(1)} GB free, ${(disk.need / 1024 ** 3).toFixed(1)} GB needed.`);
    });
    await step("guards.tools-fixture-backup", async () => {
      const check = await fixtureBackupProof(cfg, a["migration-before"], makeFixtureDb, a["allow-slow-backup"]);
      result.fixtureBackup = { mig: check.mig, rows: check.rows, mem: check.mem, seconds: check.seconds };
      note(`Fixture backup proof passed (reflink copy, checkpoint, integrity check, digest in ${check.seconds} s).`);
    });
  } else {
    note(`No backup planned (migration ${a["migration-before"]} -> ${a["migration-after"]}, no --force-backup): source levels ${levels.before} -> ${levels.after}. The live database is never opened.`);
  }
  await step("guards.active-release", async () => {
    result.activeRelease = testActiveRelease(cfg, a, { allowTarget: mode === "dryrun" || mode === "guards" });
  });
  if (mode === "run") {
    await step("guards.no-other-waiter", async () => {
      const others = otherRunners(cfg);
      if (others.length) throw new Error(`Another waiter is running: ${others.join(", ")}.`);
    });
  }
  result.e2eSource = "gate-evidence (builder run, bound to the sealed artifact)";
  return { skipBackup, levels };
}
