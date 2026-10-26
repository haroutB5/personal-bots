#!/usr/bin/env node
// hbots release runner for Linux (Omarchy). One tested, parameterised tool that replaces the per-version waiters.
// Port of run/hbots-release.ps1 (Windows). Modes (mutually exclusive):
//   --prepare      once per release after the builder's gate evidence and the pushed notes: tools copy (git archive
//                  of scripts/personal at --main-sha), seal of the staged artifact, then every guard.
//   --guards-only  every guard, exit 0/1. Nothing waits, nothing restarts.
//   --dry-run      guards + one idle look + the plan with timings; --verify-live also runs the post-restart
//                  verification read-only against the live server when the release is already live.
//   (default)      the waiter: guards -> idle gate -> heavy-job lock -> seal re-verify -> (backup) -> restart ->
//                  smoke with extended checks -> app sheet -> notice. A failed smoke rolls the binary back.
// Start it with hbots-release-launch.mjs: the runner must live OUTSIDE hbots.service's cgroup, because the restart
// it performs would otherwise kill it. The live database is never opened by this tool.
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { artifactNames, loadConfig, modeOf } from "./lib/config.mjs";
import { OPTIONS, assertParams } from "./lib/options.mjs";
import { atomicWrite, errMsg, makeRun, readJson, round1, run, runAsync, sleep, systemctl } from "./lib/util.mjs";
import { checkPins, writePins } from "./lib/pins.mjs";
import { treeInfo, verifySeal, writeLegacySeal, writeSeal } from "./lib/seal.mjs";
import { runGuards, runTool, smokeCli, testActiveRelease } from "./lib/guards.mjs";
import { heavyLockHeld, quickIdleCheck, takeHeavyLock, waitForIdle } from "./lib/idle.mjs";
import { listenerPids, liveState, selfStats } from "./lib/proc.mjs";
import { copyStopped, listBackups, pruneBackups, stamp, verifyBackup, writeManifest } from "./lib/backup.mjs";
import { postActivation, waitAlive } from "./lib/verify.mjs";
import { liveLine, sendReleaseNotice, updateAppSheet } from "./lib/sheet.mjs";

function setCurrent(cfg, release) {
  fs.writeFileSync(cfg.currentTxt, `${release}\n`);
  return fs.readFileSync(cfg.currentTxt, "utf8").trim();
}

// Without this marker the old server treats the restart as the host going offline and deletes its Cloudflare
// tunnel; the relay then provisions a new UUID and the public hostname takes 1-2 minutes to route to it.
function markUpdateRestart(cfg, note) {
  fs.mkdirSync(cfg.runtimeDir, { recursive: true });
  const marker = path.join(cfg.runtimeDir, "desktop-update-restart");
  fs.writeFileSync(marker, `${new Date().toISOString()}\n`);
  note("update-restart marker written (tunnel kept across the restart)");
}

/** pids that hold the database files open, read from /proc/<pid>/fd links (a readlink, never an open of the DB). */
function dbHolders(cfg) {
  const holders = [];
  const prefix = path.join(cfg.stateDir, "state.sqlite");
  for (const name of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
    let fds;
    try {
      fds = fs.readdirSync(`/proc/${name}/fd`);
    } catch {
      continue;
    }
    for (const fd of fds) {
      try {
        if (fs.readlinkSync(`/proc/${name}/fd/${fd}`).startsWith(prefix)) {
          holders.push(Number(name));
          break;
        }
      } catch {}
    }
  }
  return holders;
}

function lastStartOffset(file, release) {
  try {
    const text = fs.readFileSync(file, "latin1");
    const re = new RegExp(`^=== \\S+ serve release ${release} `, "gm");
    let at = -1;
    for (let m = re.exec(text); m; m = re.exec(text)) at = m.index;
    return at;
  } catch {
    return -1;
  }
}

function planTable(cfg, a, skipBackup, guardSeconds) {
  const stable = Number(a["stable-seconds"] ?? cfg.stableSeconds);
  const looks = cfg.quietLooks * (cfg.lookMs / 1000);
  const rows = [
    [`idle gate: ${cfg.quietLooks} quiet looks ${cfg.lookMs / 1000} s apart (fixed; waits longer while busy or a build holds the lock)`, looks, looks],
    ["heavy-job lock taken, seal re-verify, quick idle check", 4, 10],
    ...(skipBackup ? [] : [["backup: server stopped, reflink copy, started again (btrfs; the integrity check runs after, in the background)", 8, 25]]),
    ["restart to server up (systemctl restart + server.json)", 6, 20],
    [`smoke stability window (${stable} s; checks A run inside it)`, stable + 3, stable + 8],
    ["checks B (log scans) + sheet + notice", 1, 3],
  ];
  let low = guardSeconds;
  let high = guardSeconds;
  for (const [, l, h] of rows) {
    low += l;
    high += h;
  }
  return { rows, low, high };
}

async function main() {
  const { values: a } = parseArgs({ options: OPTIONS, strict: true });
  const cfg = loadConfig();
  if (a.help) {
    console.log(fs.readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(1, 12).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
    return 0;
  }
  if (a["write-pins"]) {
    const pins = writePins(cfg);
    console.log(`PINS.json written (${Object.keys(pins.files).length} files).`);
    return 0;
  }
  const mode = modeOf(a);
  const names = artifactNames(cfg, a);
  if ((a.prepare ? 1 : 0) + (a["guards-only"] ? 1 : 0) + (a["dry-run"] ? 1 : 0) > 1) throw new Error("Pick one of --prepare, --guards-only and --dry-run.");
  assertParams(a, mode);
  if (a["max-wait-hours"]) cfg.marathonMs = Number(a["max-wait-hours"]) * 3_600_000;
  else if (!cfg.test) cfg.marathonMs = 48 * 3_600_000;
  const armedAt = new Date().toISOString();
  const ctx = makeRun({
    mode, logFile: names.log, resultFile: names.result,
    initial: {
      runner: "hbots-release.mjs (linux)", mode, concurrency: 5, attempt: 1, version: a.version, release: a.release, rollback: a.rollback,
      mainSha: a["main-sha"], armedAt, idleAt: null, activatedAt: null, verifiedAt: null, backupExit: null, backupPath: null,
      restartExit: null, smokeExit: null, logErrors: null, logWarnings: null, liveVersion: null, rollbackExit: null, rollbackSmokeExit: null,
      error: null, host: "omarchy", node: process.version, runnerPid: process.pid,
      ...(cfg.test ? { testOverrides: true } : {}),
    },
  });
  const { result, timings, note, save, step } = ctx;
  const total0 = Date.now();
  const flags = {};
  let backupHolder = null;
  let heavy = null;
  let activationStarted = false;

  const rollback = async (reason) => {
    save("rolling_back", { error: String(reason).slice(0, 800) });
    note(`ROLLBACK: ${reason}`);
    try {
      setCurrent(cfg, a.rollback);
      markUpdateRestart(cfg, note);
      const restarted = systemctl(["restart", cfg.unit]);
      result.rollbackExit = restarted.code;
      note(`rollback: systemctl restart ${cfg.unit} exit=${restarted.code} ${restarted.out.slice(0, 160)}`);
      if (restarted.code !== 0) throw new Error(`systemctl restart failed: ${restarted.out.slice(0, 200)}`);
      const state = await waitAlive(cfg, a.rollback, cfg.startTimeoutMs);
      if (!state) throw new Error("server did not come back on the rollback release in time");
      const smoke = await runAsync(cfg.node, [smokeCli(cfg, names), "smoke", "--root", "dev", "--expect-release", a.rollback, "--stable-seconds", String(Math.min(60, Number(a["stable-seconds"] ?? cfg.stableSeconds))), "--start-timeout", String(Math.round(cfg.startTimeoutMs / 1000))], { env: { ...process.env, HOME: cfg.test ? path.dirname(cfg.home) : process.env.HOME } });
      result.rollbackSmokeExit = smoke.code;
      for (const line of smoke.out.split("\n")) note(`rollback smoke ${line}`);
      if (smoke.code !== 0) throw new Error(`rollback smoke failed (exit ${smoke.code})`);
      save("rolled_back");
      note(`rolled back cleanly to ${a.rollback}`);
    } catch (error) {
      save("rollback_failed", { error: `${String(reason).slice(0, 500)} / rollback: ${errMsg(error)}`.slice(0, 900) });
      note(`ROLLBACK FAILED: ${errMsg(error)}`);
    }
  };

  try {
    save("starting");
    note(`Runner ${mode} for ${a.version} (${a.release}), rollback ${a.rollback}, notes commit ${a["main-sha"]}${cfg.test ? " [TEST OVERRIDES]" : ""}. node ${process.version}, pid ${process.pid}.`);

    if (mode === "prepare") {
      assertParams(a, mode);
      await step("prepare.pinned-helpers", async () => {
        note(`Pinned helpers match (${checkPins(cfg)} files).`);
      });
      await step("prepare.tools-copy", async () => {
        const tmp = fs.mkdtempSync(path.join(cfg.run, `.hbots-tools-${a.version}-`));
        try {
          const tar = path.join(tmp, "a.tar");
          const x = path.join(tmp, "x");
          fs.mkdirSync(x);
          const arch = run("git", ["-C", a["repo-root"], "archive", "--format=tar", "-o", tar, a["main-sha"], "scripts/personal"], { timeout: 120_000 });
          if (arch.code !== 0) throw new Error(`git archive of scripts/personal at ${a["main-sha"]} failed (is the commit fetched?): ${arch.err.slice(0, 200)}`);
          if (run("tar", ["-xf", tar, "-C", x]).code !== 0) throw new Error("tar extract failed.");
          const fresh = await treeInfo(cfg, path.join(x, "scripts"));
          if (fs.existsSync(names.tools)) {
            const have = await treeInfo(cfg, path.join(names.tools, "scripts"));
            if (have.sha256 !== fresh.sha256) throw new Error(`Existing ${names.tools} differs from git archive of ${a["main-sha"]} (${have.files} vs ${fresh.files} files). Remove that folder (a plain copy, no symlinks) and run --prepare again.`);
            note(`Tools copy ${names.tools} already matches git archive of ${a["main-sha"]} (${fresh.files} files).`);
          } else {
            fs.mkdirSync(names.tools, { recursive: true });
            fs.cpSync(path.join(x, "scripts"), path.join(names.tools, "scripts"), { recursive: true });
            note(`Tools copy written: ${names.tools} (${fresh.files} files, whole scripts/personal tree of ${a["main-sha"]}).`);
          }
        } finally {
          if (path.basename(tmp).startsWith(".hbots-tools-")) fs.rmSync(tmp, { recursive: true, force: true });
        }
      });
      await step("prepare.seal", async () => {
        if (a["legacy-no-evidence"]) flags.seal = await writeLegacySeal(cfg, a, names, note);
        else flags.seal = await writeSeal(cfg, a, names, note);
      });
      const g = await runGuards(cfg, a, names, ctx, flags);
      result.sealSha256 = (await import("./lib/util.mjs")).sha256File(names.seal);
      save("prepared");
      note(`PREPARED ${a.version} (${a.release}) in ${round1((Date.now() - total0) / 1000)} s. Next: --dry-run, then the launcher when the CTO steers SHIP. Backup: ${g.skipBackup ? "skipped (no migration)" : "planned"}.`);
      return 0;
    }

    save("guards");
    const g = await runGuards(cfg, a, names, ctx, flags);
    result.sealSha256 = (await import("./lib/util.mjs")).sha256File(names.seal);
    const guardSeconds = Object.entries(timings).filter(([k]) => k.startsWith("guards.")).reduce((s, [, v]) => s + v, 0);

    if (mode === "guards") {
      save("guards_ok");
      note(`All guards passed in ${round1((Date.now() - total0) / 1000)} s.`);
      return 0;
    }

    if (mode === "dryrun") {
      const idle = await step("idle.one-look", () => quickIdleCheck(cfg, 3000));
      result.idleLook = idle.idle ? "idle" : `busy: ${idle.reasons.join(" ")}`;
      const lock = heavyLockHeld(cfg.heavyLock);
      result.heavyLockHeld = lock.held;
      note(`Idle look now: ${result.idleLook}; heavy-job lock ${lock.held ? `HELD (${lock.holder})` : "free"} (a real run needs ${cfg.quietLooks} quiet looks ${cfg.lookMs / 1000} s apart and waits while the lock is held).`);
      const active = testActiveRelease(cfg, a, { allowTarget: true });
      result.activeRelease = active;
      if (a["verify-live"]) {
        if (active === a.release) {
          const stable = Number(a["stable-seconds"] || 20);
          const server = readJson(cfg.serverJson);
          const logFile = String(server.logFile);
          const start = lastStartOffset(logFile, a.release);
          const size = fs.statSync(logFile).size;
          const vctx = { expVersion: a.version, serverLog: logFile, logByte: start >= 0 ? start : Math.max(0, size - 65536), restartExit: 0, skipStartupMarker: start < 0 };
          result.verifyLiveLogFrom = vctx.logByte;
          save("verify_live");
          const pa = await step("verifylive.post-activation (smoke+checks)", () => postActivation(cfg, a, names, vctx, stable, result, timings, note));
          result.smokeExit = pa.smokeExit;
          if (pa.smokeExit !== 0) {
            result.error = pa.error ?? `smoke exit ${pa.smokeExit}`;
            throw new Error(`VerifyLive failed: ${result.error}`);
          }
        } else note(`VerifyLive skipped: active release is ${active}, not ${a.release}.`);
      }
      const plan = planTable(cfg, a, g.skipBackup, guardSeconds);
      result.plan = plan;
      const backups = listBackups(cfg);
      result.backupKeep = Number(a["backup-keep"]);
      result.backupsWouldPrune = g.skipBackup ? [] : backups.slice(Math.max(0, Number(a["backup-keep"]) - 1));
      note(g.skipBackup ? `No backup planned (no migration); ${backups.length} timestamp backups stay as they are.` : `Backup retention: ${backups.length} now; the fresh one makes ${backups.length + 1}; --backup-keep ${a["backup-keep"]} would prune ${result.backupsWouldPrune.length}${result.backupsWouldPrune.length ? `: ${result.backupsWouldPrune.join(", ")}` : ""}.`);
      Object.assign(result, { selfStats: selfStats(null) });
      save("dryrun_ok");
      note("");
      note(`DRY RUN OK for ${a.version} (${a.release}): every guard passed; backup, restart and notice were NOT run.`);
      for (const [k, v] of Object.entries(timings)) note(`  ${k.padEnd(48)} ${String(v).padStart(7)} s`);
      note("Planned (not run in a dry run; estimates):");
      for (const [label, l, h] of plan.rows) note(`  ${label.padEnd(100)} ${l === h ? l : `${l}-${h}`} s`);
      note(`  EXPECTED arm -> verified, idle from the start: ${Math.round(plan.low)}-${Math.round(plan.high)} s (${round1(plan.low / 60)}-${round1(plan.high / 60)} min; 1.66.95 took 6 min)`);
      return 0;
    }

    // ---- real run ----
    save("waiting_for_idle");
    if (g.skipBackup) result.backupSkipped = true;
    const waitStart = Date.now();
    result.idleLooks = [];
    let confirmed = false;
    while (!confirmed) {
      if (Date.now() - waitStart > cfg.marathonMs) throw new Error(`No quiet window within ${round1(cfg.marathonMs / 3_600_000)} hours; nothing was activated.`);
      const waited = await waitForIdle(cfg, {
        onLook: (entry, quiet) => {
          result.idleLooks.push(entry);
          if (result.idleLooks.length > 60) result.idleLooks.shift();
          save("waiting_for_idle");
          note(entry.busyReason ? `busy ${entry.busyReason}` : `quiet ${quiet}/${cfg.quietLooks} cpu=${entry.cpu}s`);
        },
      });
      if (!waited.idle) throw new Error(`Still busy after ${round1(waited.waitedS / 3600)} hours; not restarted.`);
      // From here a build cannot start (heavy-job.sh waits on the lock) until the release is verified.
      heavy = await takeHeavyLock(cfg.heavyLock, `hbots-release ${a.version}`);
      if (!heavy) {
        note("heavy-job lock is held (a build started): back to waiting");
        continue;
      }
      note(`heavy-job lock taken (holder pid ${heavy.pid}) until the release is verified`);
      testActiveRelease(cfg, a);
      await step("seal.reverify-before-restart", () => verifySeal(cfg, a, names));
      const quick = await quickIdleCheck(cfg, 3000);
      if (!quick.idle) {
        note(`work resumed before the restart (${quick.reasons.join(" ")}): back to waiting`);
        heavy.release();
        heavy = null;
        continue;
      }
      confirmed = true;
    }
    result.idleAt = new Date().toISOString();
    timings["idle.wait"] = round1((Date.now() - waitStart) / 1000);
    note(`Idle confirmed; ${g.skipBackup ? "no backup (no migration)" : "backup with the server stopped"}, then activation -> ${a.release}`);

    const before = readJson(cfg.serverJson);
    let serverLog = String(before.logFile);
    let logByte = fs.statSync(serverLog).size;
    save("activating");
    activationStarted = true;
    const restart0 = Date.now();
    setCurrent(cfg, a.release);
    markUpdateRestart(cfg, note);
    let backupDir = null;
    if (!g.skipBackup) {
      save("backing_up");
      backupDir = path.join(cfg.backups, stamp());
      result.backupPath = backupDir;
      const startedAt = Date.now();
      const stop = systemctl(["stop", cfg.unit]);
      const oldPid = Number(before.pid);
      const inactive = systemctl(["is-active", cfg.unit]).out.trim();
      const holders = dbHolders(cfg);
      try {
        if (stop.code !== 0 || inactive !== "inactive") throw new Error(`could not stop ${cfg.unit}: ${stop.out.slice(0, 160)} (state ${inactive})`);
        if (fs.existsSync(`/proc/${oldPid}`)) throw new Error(`old server pid ${oldPid} is still alive after the stop`);
        if (holders.length) throw new Error(`pid(s) ${holders.join(",")} still hold the database open; not copying`);
        const copied = copyStopped(cfg, backupDir, { allowSlow: a["allow-slow-backup"] });
        writeManifest(backupDir, { schema: 1, method: "stopped-reflink-copy", root: "dev", createdAt: new Date().toISOString(), release: a.rollback, files: copied, validation: null });
        result.backupExit = 0;
        note(`backup copy written with the server stopped: ${backupDir} (${round1((Date.now() - startedAt) / 1000)} s stopped)`);
      } catch (error) {
        result.backupExit = 1;
        setCurrent(cfg, a.rollback);
        systemctl(["start", cfg.unit]);
        throw Object.assign(new Error(`Backup failed, server restarted on ${a.rollback}: ${errMsg(error)}`), { noRollback: true });
      }
      timings["backup.stopped-window"] = round1((Date.now() - startedAt) / 1000);
      const started = systemctl(["start", cfg.unit]);
      result.restartExit = started.code;
      if (started.code !== 0) throw new Error(`systemctl start failed: ${started.out.slice(0, 300)}`);
    } else {
      const restarted = systemctl(["restart", cfg.unit]);
      result.restartExit = restarted.code;
      note(`systemctl restart ${cfg.unit} exit=${restarted.code} ${restarted.out.slice(0, 160)}`);
      if (restarted.code !== 0) throw new Error(`systemctl restart failed: ${restarted.out.slice(0, 300)}`);
    }
    const state = await waitAlive(cfg, a.release, cfg.startTimeoutMs);
    timings.restart = round1((Date.now() - restart0) / 1000);
    if (!state) throw new Error(`server did not come back on ${a.release} within ${Math.round(cfg.startTimeoutMs / 1000)} s`);
    result.activatedAt = state.startedAt ?? new Date().toISOString();
    if (String(state.logFile) !== serverLog) {
      serverLog = String(state.logFile);
      logByte = 0;
    }
    result.serverLog = serverLog;
    result.logFromByte = logByte;
    note(`server back: pid ${state.pid} release ${state.release} (${timings.restart} s from the restart call)`);

    // The backup copy is checked at background priority while the new release is already up.
    const backupCheck = backupDir ? verifyBackup(cfg, backupDir, a["migration-before"]).then((r) => ({ ok: true, r }), (e) => ({ ok: false, e })) : null;

    save("smoking");
    const vctx = { expVersion: a.version, serverLog, logByte, restartExit: result.restartExit, skipStartupMarker: false };
    const stable = Number(a["stable-seconds"] ?? cfg.stableSeconds);
    const pa = await step("post.activation (smoke + checks)", () => postActivation(cfg, a, names, vctx, stable, result, timings, note));
    result.smokeExit = pa.smokeExit;
    if (pa.error) result.error = pa.error;
    if (pa.smokeExit !== 0) {
      save();
      throw new Error(pa.error || `Release smoke failed, exit ${pa.smokeExit}.`);
    }
    result.verifiedAt = new Date().toISOString();
    result.liveVersion = a.version;
    heavy?.release();
    heavy = null;
    timings.armToVerified = round1((Date.now() - total0) / 1000);
    timings.restartToVerified = round1((Date.now() - restart0) / 1000);
    save("live_verified");
    if (backupCheck) {
      const bc = await backupCheck;
      if (bc.ok) {
        result.backupVerified = true;
        result.backupMaxMigration = bc.r.mig;
        result.backupActivityRows = bc.r.rows;
        result.backupMemoryRows = bc.r.mem;
        timings["backup.verify-background"] = bc.r.seconds;
        const pruned = pruneBackups(cfg, Number(a["backup-keep"]));
        result.backupKeep = Number(a["backup-keep"]);
        result.backupsPruned = pruned;
        note(`Verified fresh backup ${backupDir} (migration ${bc.r.mig}, integrity ok, activity rows ${bc.r.rows}, memory rows ${bc.r.mem}); pruned ${pruned.length}${pruned.length ? `: ${pruned.join(", ")}` : ""}.`);
      } else {
        result.backupVerified = false;
        result.backupError = errMsg(bc.e);
        result.error = `release is live but the fresh backup failed its check: ${result.backupError}`;
        note(`WARNING: ${result.error}`);
      }
      save();
    }
    try {
      const t = Date.now();
      updateAppSheet(a, liveLine(a, result), note);
      timings["sheet-update"] = round1((Date.now() - t) / 1000);
    } catch (error) {
      result.error = errMsg(error);
      save("live_verified_doc_update_failed");
      note(`App sheet update failed: ${result.error}`);
    }
    result.selfStats = selfStats(process.env.HBOTS_RELEASE_UNIT);
    save();
    note(`Done: ${result.status} in ${timings.armToVerified} s from start (restart to verified ${timings.restartToVerified} s). Runner cpu ${result.selfStats.cpuSeconds ?? "?"} s, peak RSS ${result.selfStats.peakRssMb ?? "?"} MB.`);
    return 0;
  } catch (error) {
    result.error = errMsg(error);
    heavy?.release?.();
    if (result.status === "live_verified") save("live_verified_doc_update_failed");
    else if (activationStarted && !error.noRollback && ["activating", "backing_up", "smoking"].includes(result.status)) {
      if (result.smokeExit == null) result.smokeExit = 1;
      await rollback(result.error);
    } else if (result.status === "rolling_back") save("rollback_failed");
    else save("failed");
    result.selfStats = selfStats(process.env.HBOTS_RELEASE_UNIT);
    note(`FAILED: ${result.error}`);
    save();
    return 1;
  } finally {
    try {
      heavy?.release?.();
    } catch {}
    if (mode === "run") await sendReleaseNotice(cfg, a, result, names.log, note, save);
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    console.error(errMsg(error));
    process.exitCode = 2;
  },
);
